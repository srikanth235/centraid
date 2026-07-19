/*
 * The gateway device registry (issue #289 phase 2) — device key ↔ vault.
 *
 * Enrollment is the ENTIRE ACL: each row binds one device's public key
 * (iroh EndpointId) to one vault, with a label and enrollment time.
 * Multi-vault access = multiple rows. Revocation is per row ("lost
 * laptop" = revoke that key); listing is per vault ("your devices").
 * There are no roles and no permission matrix — enrollment is one bit.
 *
 * Persistence mirrors the phone tunnel's `devices.json` (issue #263):
 * a JSON file with mode 0600 and atomic replace. Mutations take an atomic
 * lock-directory around reload → update → replace so a CLI checkpoint/trust
 * change cannot race the daemon and resurrect stale authorization state.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_STAT_TTL_MS = 1_000;

export interface DeviceEnrollment {
  /** Row id — the revocation handle. */
  enrollmentId: string;
  /** The device's public key: its iroh EndpointId (base32). */
  endpointId: string;
  /** The one vault this row opens. */
  vaultId: string;
  /** Owner-facing label ("Priya's laptop"). */
  label: string;
  /** Client platform, when the pairing ceremony reported one. */
  platform?: string;
  /**
   * Device trust is part of the server-side replica shape (#406). A
   * read-only device may bootstrap and tail its consented rows but may not
   * submit an intent. Revoked rows are normally removed immediately; the
   * value remains in the type so a future tombstone-backed revocation can
   * fail closed without widening an older client.
   */
  trust: 'full' | 'readonly' | 'revoked';
  /**
   * Whether durable client state was explicitly requested at pairing time.
   * The daemon persists the choice alongside enrollment; clients use it to
   * decide between OPFS/IndexedDB and session-memory state.
   */
  rememberDevice: boolean;
  /** Owner opt-in plus the compute this device most recently advertised. */
  compute?: DeviceComputeProfile;
  /** Last replica cursor the authenticated device explicitly acknowledged. */
  checkpoint?: ReplicaCheckpoint;
  /** ISO enrollment time. */
  addedAt: string;
}

export interface DeviceComputeCapabilities {
  previews: boolean;
  poster: boolean;
  pdfText: boolean;
  ocr: boolean;
  embedding: boolean;
  transcript: boolean;
  edgeSeal: boolean;
  backgroundTransfer: boolean;
}

export interface DeviceComputeProfile {
  contributeWhileCharging: boolean;
  capabilities: DeviceComputeCapabilities;
  updatedAt: string;
}

export interface ReplicaCheckpoint {
  epoch: string;
  seq: number;
  /** Build/schema compatibility epoch used to derive the replica. */
  schemaEpoch: number;
  updatedAt: string;
}

interface EnrollmentFile {
  version: 1;
  enrollments: DeviceEnrollment[];
}

export class EnrollmentStore {
  private enrollments: DeviceEnrollment[] = [];
  private loadedRevision = '';
  private nextStatAt = 0;

  private constructor(
    private readonly file: string,
    private readonly statTtlMs: number,
    private readonly now: () => number,
  ) {}

  static open(
    file: string,
    options: { statTtlMs?: number; now?: () => number } = {},
  ): EnrollmentStore {
    const store = new EnrollmentStore(
      file,
      options.statTtlMs ?? DEFAULT_STAT_TTL_MS,
      options.now ?? Date.now,
    );
    store.reloadIfChanged();
    return store;
  }

  /** Re-read the file when another process (CLI ↔ daemon) rewrote it. */
  private reloadIfChanged(force = false): void {
    const now = this.now();
    if (!force && now < this.nextStatAt) return;
    this.nextStatAt = now + this.statTtlMs;
    let revision: string;
    try {
      const stat = fs.statSync(this.file, { bigint: true });
      revision = `${stat.mtimeNs}:${stat.size}`;
    } catch {
      this.enrollments = [];
      this.loadedRevision = '';
      return;
    }
    if (revision === this.loadedRevision) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<EnrollmentFile>;
      this.enrollments = Array.isArray(raw.enrollments)
        ? raw.enrollments.flatMap((value) => {
            const enrollment = normalizeEnrollment(value);
            return enrollment ? [enrollment] : [];
          })
        : [];
      this.loadedRevision = revision;
    } catch {
      // Unreadable file: keep the last good in-memory set (never widen
      // access on a parse failure — an empty set only denies).
      this.enrollments = [];
      this.loadedRevision = revision;
    }
  }

  private persist(): void {
    const payload: EnrollmentFile = { version: 1, enrollments: this.enrollments };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    const stat = fs.statSync(this.file, { bigint: true });
    this.loadedRevision = `${stat.mtimeNs}:${stat.size}`;
    this.nextStatAt = this.now() + this.statTtlMs;
  }

  private mutate<T>(change: () => T): T {
    return withEnrollmentFileLock(this.file, () => {
      // Never trust an in-memory snapshot after waiting for another process.
      this.loadedRevision = '';
      this.reloadIfChanged(true);
      const result = change();
      this.persist();
      return result;
    });
  }

  /** Every enrollment, oldest first. */
  list(): DeviceEnrollment[] {
    this.reloadIfChanged();
    return [...this.enrollments];
  }

  /** Force an external-process refresh (used only after an OS file-change event). */
  listFresh(): DeviceEnrollment[] {
    this.reloadIfChanged(true);
    return [...this.enrollments];
  }

  /** The devices enrolled in one vault ("your devices"). */
  listByVault(vaultId: string): DeviceEnrollment[] {
    return this.list().filter((e) => e.vaultId === vaultId);
  }

  /** The vault ids one device key opens, oldest enrollment first. */
  vaultsFor(endpointId: string): string[] {
    return this.list()
      .filter((e) => e.endpointId === endpointId)
      .map((e) => e.vaultId);
  }

  /** Whether this device key opens anything at all (transport admission). */
  isEnrolled(endpointId: string): boolean {
    return this.vaultsFor(endpointId).length > 0;
  }

  /**
   * Bind one device key to one vault. Idempotent per (key, vault): re-pair
   * refreshes the label instead of duplicating the row.
   */
  enroll(input: {
    endpointId: string;
    vaultId: string;
    label: string;
    platform?: string;
    trust?: 'full' | 'readonly';
    rememberDevice?: boolean;
  }): DeviceEnrollment {
    return this.mutate(() => {
      const existing = this.enrollments.find(
        (e) => e.endpointId === input.endpointId && e.vaultId === input.vaultId,
      );
      if (existing) {
        existing.label = input.label;
        if (input.platform !== undefined) existing.platform = input.platform;
        if (input.trust !== undefined) existing.trust = input.trust;
        if (input.rememberDevice !== undefined) existing.rememberDevice = input.rememberDevice;
        return { ...existing };
      }
      const row: DeviceEnrollment = {
        enrollmentId: crypto.randomUUID(),
        endpointId: input.endpointId,
        vaultId: input.vaultId,
        label: input.label,
        ...(input.platform !== undefined ? { platform: input.platform } : {}),
        trust: input.trust ?? 'full',
        rememberDevice: input.rememberDevice === true,
        addedAt: new Date().toISOString(),
      };
      this.enrollments.push(row);
      return { ...row };
    });
  }

  /** The enrollment for one authenticated device/vault pair. */
  get(endpointId: string, vaultId: string): DeviceEnrollment | undefined {
    return this.list().find((e) => e.endpointId === endpointId && e.vaultId === vaultId);
  }

  /**
   * Stamp the cursor returned by a fresh bootstrap. This is the only method
   * allowed to replace an enrollment's epoch; ordinary acknowledgements may
   * only advance monotonically within the bootstrapped epoch.
   */
  resetCheckpoint(
    endpointId: string,
    vaultId: string,
    cursor: Omit<ReplicaCheckpoint, 'updatedAt'>,
  ): ReplicaCheckpoint {
    return this.mutate(() => {
      const enrollment = this.mutableEnrollment(endpointId, vaultId);
      const checkpoint = checkpointNow(cursor);
      enrollment.checkpoint = checkpoint;
      return checkpoint;
    });
  }

  /** Persist an authenticated device's monotonically advancing cursor. */
  advanceCheckpoint(
    endpointId: string,
    vaultId: string,
    cursor: Omit<ReplicaCheckpoint, 'updatedAt'>,
  ): ReplicaCheckpoint {
    return this.mutate(() => {
      const enrollment = this.mutableEnrollment(endpointId, vaultId);
      const previous = enrollment.checkpoint;
      if (!previous) {
        throw new Error('replica checkpoint must be initialized by bootstrap');
      }
      if (previous.epoch !== cursor.epoch || previous.schemaEpoch !== cursor.schemaEpoch) {
        throw new Error('replica checkpoint epoch changed; rebootstrap required');
      }
      if (!Number.isSafeInteger(cursor.seq) || cursor.seq < previous.seq) {
        throw new Error('replica checkpoint must advance monotonically');
      }
      const checkpoint = checkpointNow(cursor);
      enrollment.checkpoint = checkpoint;
      return checkpoint;
    });
  }

  /** Owner-controlled trust downgrade/upgrade for an enrolled device. */
  setTrust(
    endpointId: string,
    vaultId: string,
    trust: 'full' | 'readonly' | 'revoked',
  ): DeviceEnrollment {
    return this.mutate(() => {
      const enrollment = this.mutableEnrollment(endpointId, vaultId);
      enrollment.trust = trust;
      if (trust === 'revoked') delete enrollment.checkpoint;
      return { ...enrollment };
    });
  }

  /** Persist the owner's work-sharing choice and the device's advertised compute. */
  setCompute(
    enrollmentId: string,
    input: Omit<DeviceComputeProfile, 'updatedAt'>,
  ): DeviceEnrollment {
    return this.mutate(() => {
      const enrollment = this.enrollments.find((row) => row.enrollmentId === enrollmentId);
      if (!enrollment || enrollment.trust === 'revoked') {
        throw new Error('device enrollment was not found');
      }
      enrollment.compute = { ...input, updatedAt: new Date().toISOString() };
      return { ...enrollment, compute: { ...enrollment.compute } };
    });
  }

  private mutableEnrollment(endpointId: string, vaultId: string): DeviceEnrollment {
    this.reloadIfChanged();
    const enrollment = this.enrollments.find(
      (e) => e.endpointId === endpointId && e.vaultId === vaultId,
    );
    if (!enrollment || enrollment.trust === 'revoked') {
      throw new Error('device is not enrolled for this vault');
    }
    return enrollment;
  }

  /**
   * Revoke by enrollment id (one row) or by endpoint id (every row that
   * key holds — "lost laptop"). Returns the removed rows.
   */
  revoke(idOrEndpointId: string): DeviceEnrollment[] {
    return this.mutate(() => {
      const removed = this.enrollments.filter(
        (e) => e.enrollmentId === idOrEndpointId || e.endpointId === idOrEndpointId,
      );
      if (removed.length === 0) return [];
      this.enrollments = this.enrollments.filter((e) => !removed.includes(e));
      return removed.map((row) => ({ ...row }));
    });
  }
}

const ENROLLMENT_STALE_LOCK_MS = 60_000;

function withEnrollmentFileLock<T>(file: string, work: () => T): T {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  for (;;) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > ENROLLMENT_STALE_LOCK_MS) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      // Store mutations are synchronous for CLI compatibility. Waiting here
      // would block the daemon event loop, so a live competing writer fails
      // fast and lets the caller retry instead of freezing all HTTP traffic.
      throw new Error('device enrollment store is busy', { cause: error });
    }
  }
  try {
    return work();
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {
      /* A stale-lock recovery racing process may already have removed it. */
    }
  }
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST'
  );
}

function validCheckpoint(value: unknown): value is ReplicaCheckpoint {
  if (typeof value !== 'object' || value === null) return false;
  const checkpoint = value as Partial<ReplicaCheckpoint>;
  return (
    typeof checkpoint.epoch === 'string' &&
    checkpoint.epoch.length > 0 &&
    typeof checkpoint.seq === 'number' &&
    Number.isSafeInteger(checkpoint.seq) &&
    checkpoint.seq >= 0 &&
    typeof checkpoint.schemaEpoch === 'number' &&
    Number.isSafeInteger(checkpoint.schemaEpoch) &&
    checkpoint.schemaEpoch >= 0 &&
    typeof checkpoint.updatedAt === 'string'
  );
}

function normalizeEnrollment(value: unknown): DeviceEnrollment | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const enrollment = value as Partial<DeviceEnrollment>;
  const valid =
    typeof enrollment.enrollmentId === 'string' &&
    typeof enrollment.endpointId === 'string' &&
    typeof enrollment.vaultId === 'string' &&
    typeof enrollment.label === 'string' &&
    typeof enrollment.addedAt === 'string' &&
    (enrollment.platform === undefined || typeof enrollment.platform === 'string') &&
    (enrollment.trust === undefined ||
      enrollment.trust === 'full' ||
      enrollment.trust === 'readonly' ||
      enrollment.trust === 'revoked') &&
    (enrollment.rememberDevice === undefined || typeof enrollment.rememberDevice === 'boolean') &&
    (enrollment.compute === undefined || validComputeProfile(enrollment.compute)) &&
    (enrollment.checkpoint === undefined || validCheckpoint(enrollment.checkpoint));
  if (!valid) return undefined;
  return {
    ...(enrollment as DeviceEnrollment),
    // Pre-#406 rows were full-trust and session-only by construction.
    trust: enrollment.trust ?? 'full',
    rememberDevice: enrollment.rememberDevice ?? false,
  };
}

const COMPUTE_CAPABILITIES: readonly (keyof DeviceComputeCapabilities)[] = [
  'previews',
  'poster',
  'pdfText',
  'ocr',
  'embedding',
  'transcript',
  'edgeSeal',
  'backgroundTransfer',
];

function validComputeProfile(value: unknown): value is DeviceComputeProfile {
  if (typeof value !== 'object' || value === null) return false;
  const profile = value as Partial<DeviceComputeProfile>;
  if (
    typeof profile.contributeWhileCharging !== 'boolean' ||
    typeof profile.updatedAt !== 'string' ||
    typeof profile.capabilities !== 'object' ||
    profile.capabilities === null
  ) {
    return false;
  }
  const capabilities = profile.capabilities as Partial<DeviceComputeCapabilities>;
  return COMPUTE_CAPABILITIES.every((key) => typeof capabilities[key] === 'boolean');
}

function checkpointNow(cursor: Omit<ReplicaCheckpoint, 'updatedAt'>): ReplicaCheckpoint {
  if (
    !cursor.epoch ||
    !Number.isSafeInteger(cursor.seq) ||
    cursor.seq < 0 ||
    !Number.isSafeInteger(cursor.schemaEpoch) ||
    cursor.schemaEpoch < 0
  ) {
    throw new Error('invalid replica checkpoint');
  }
  return { ...cursor, updatedAt: new Date().toISOString() };
}
