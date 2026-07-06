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
 * a JSON file with mode 0600 and atomic replace. The store re-reads the
 * file when its mtime moves, so the admin CLI (a separate process) and
 * the daemon see each other's writes without coordination.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
  /** ISO enrollment time. */
  addedAt: string;
}

interface EnrollmentFile {
  version: 1;
  enrollments: DeviceEnrollment[];
}

export class EnrollmentStore {
  private enrollments: DeviceEnrollment[] = [];
  private loadedMtimeMs = -1;

  private constructor(private readonly file: string) {}

  static open(file: string): EnrollmentStore {
    const store = new EnrollmentStore(file);
    store.reloadIfChanged();
    return store;
  }

  /** Re-read the file when another process (CLI ↔ daemon) rewrote it. */
  private reloadIfChanged(): void {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      this.enrollments = [];
      this.loadedMtimeMs = -1;
      return;
    }
    if (mtimeMs === this.loadedMtimeMs) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<EnrollmentFile>;
      this.enrollments = Array.isArray(raw.enrollments)
        ? raw.enrollments.filter(
            (e): e is DeviceEnrollment =>
              typeof e === 'object' &&
              e !== null &&
              typeof (e as DeviceEnrollment).enrollmentId === 'string' &&
              typeof (e as DeviceEnrollment).endpointId === 'string' &&
              typeof (e as DeviceEnrollment).vaultId === 'string',
          )
        : [];
      this.loadedMtimeMs = mtimeMs;
    } catch {
      // Unreadable file: keep the last good in-memory set (never widen
      // access on a parse failure — an empty set only denies).
      this.enrollments = [];
      this.loadedMtimeMs = mtimeMs;
    }
  }

  private persist(): void {
    const payload: EnrollmentFile = { version: 1, enrollments: this.enrollments };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.loadedMtimeMs = fs.statSync(this.file).mtimeMs;
  }

  /** Every enrollment, oldest first. */
  list(): DeviceEnrollment[] {
    this.reloadIfChanged();
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
  }): DeviceEnrollment {
    this.reloadIfChanged();
    const existing = this.enrollments.find(
      (e) => e.endpointId === input.endpointId && e.vaultId === input.vaultId,
    );
    if (existing) {
      existing.label = input.label;
      if (input.platform !== undefined) existing.platform = input.platform;
      this.persist();
      return existing;
    }
    const row: DeviceEnrollment = {
      enrollmentId: crypto.randomUUID(),
      endpointId: input.endpointId,
      vaultId: input.vaultId,
      label: input.label,
      ...(input.platform !== undefined ? { platform: input.platform } : {}),
      addedAt: new Date().toISOString(),
    };
    this.enrollments.push(row);
    this.persist();
    return row;
  }

  /**
   * Revoke by enrollment id (one row) or by endpoint id (every row that
   * key holds — "lost laptop"). Returns the removed rows.
   */
  revoke(idOrEndpointId: string): DeviceEnrollment[] {
    this.reloadIfChanged();
    const removed = this.enrollments.filter(
      (e) => e.enrollmentId === idOrEndpointId || e.endpointId === idOrEndpointId,
    );
    if (removed.length === 0) return [];
    this.enrollments = this.enrollments.filter((e) => !removed.includes(e));
    this.persist();
    return removed;
  }
}
