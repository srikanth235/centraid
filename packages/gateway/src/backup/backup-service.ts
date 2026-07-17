// governance: allow-repo-hygiene file-size-limit (#408) the backup service is one serialized run-chain contract — backup, verify, restore-verify and the wal drain all share its state row, fencing, keyring and health surfaces; splitting them would scatter one lifecycle across files that only ever change together
/*
 * `BackupService` — the gateway-side owner of the offsite backup engine
 * (`@centraid/backup`, PROTOCOL.md + FORMAT.md). Static CLI configuration
 * or the desktop's live provider connection resolves through one engine;
 * manual runs and the scheduler intentionally share the same code path.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BackupProviderError,
  createKeyring,
  createSnapshot,
  loadKeyring,
  openLocalBackupProvider,
  openManifest,
  openRemoteBackupProvider,
  restoreSnapshot,
  verifySnapshot,
  type BackupProvider,
  type Keyring,
  type Retention,
  type RestoreResult,
  type SnapshotRow,
  type SourceEntry,
  type VerifySnapshotResult,
} from '@centraid/backup';
import {
  DEFAULT_BACKUP_POLICY,
  MIN_RPO_SECONDS,
  ONTOLOGY_VERSION,
  VAULT_MIGRATIONS,
  bumpReplicaEpoch,
  readBackupPolicy,
  readBlobStoreSettings,
  verifyRestoredPair,
  type BackupPolicy,
  type RemoteTier,
} from '@centraid/vault';
import { warmPreviewTinies, type PreviewsWarmResult } from './restore-warm.js';
import type { RuntimeLogger } from '@centraid/app-engine';
import { type BackupConfig, type BackupProviderConfig } from './backup-config.js';
import { discardWalFiles, drainWalFiles, pruneWalGenerations, walPairKey } from './wal-uploader.js';
import {
  loadBackupState,
  opaqueLabel,
  saveBackupState,
  type BackupState,
  type BackupTargetState,
  type RecoveryKitState,
} from './backup-state.js';
import type { RecoveryKitStateStore } from './recovery-kit-state.js';
import { assembleSourceEntries, resetStagingDir, type AssembleOptions } from './backup-sources.js';
import type { HealthRegistry } from '../serve/health-registry.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import type { VaultPlane } from '../serve/vault-plane.js';
import type { StorageConnectionStore } from './storage-connections.js';
import { GATEWAY_VERSION } from '../version.js';
import { resolveBackupBackend } from './backup-backend.js';
import { evaluateBackupHealth } from './backup-health.js';
import { recoveryKitDocument, writeBackupRecoveryKit } from './backup-recovery-kit.js';
import {
  inspectProviderPolicy,
  providerPolicyFor,
  providerPolicyMatches,
  pushProviderPolicy,
  type ProviderPolicySyncState,
} from './backup-provider-observability.js';
import {
  failedReconciliation,
  runBackupReconciliation,
  type BackupReconciliationState,
} from './backup-reconciliation.js';
import {
  failedCasOnlyReconciliation,
  runCasOnlyReconciliation,
} from './backup-cas-reconciliation.js';
import { snapshotReferencedBlobShas } from './snapshot-blob-roots.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Re-check policy at its declared minimum; each vault still drains only when its own RPO is due. */
const POLICY_SCHEDULER_TICK_MS = MIN_RPO_SECONDS * 1000;

function newestReconciliation(
  first: BackupReconciliationState | undefined,
  second: BackupReconciliationState | undefined,
): BackupReconciliationState | undefined {
  if (!first) return second;
  if (!second) return first;
  return Date.parse(first.checkedAt) >= Date.parse(second.checkedAt) ? first : second;
}

/** A materialized restore is a new replica history, never a continuation. */
function invalidateRestoredReplica(destDir: string): void {
  const vault = new DatabaseSync(path.join(destDir, 'vault.db'));
  try {
    bumpReplicaEpoch(vault, { reason: 'backup-restore' });
  } finally {
    vault.close();
  }
}

export function buildBackupProvider(config: BackupProviderConfig): BackupProvider {
  return config.kind === 'local'
    ? openLocalBackupProvider({ rootDir: config.dir })
    : openRemoteBackupProvider({ baseUrl: config.endpoint, apiKey: config.apiKey });
}

export interface BackupServiceOptions {
  /** Static daemon/CLI configuration. When omitted, the active provider storage connection is resolved live. */
  config?: BackupConfig;
  /** `<dataDir>/backup` — holds `keyring.json`, `state.json`, `staging/`. */
  backupDir: string;
  vaults: VaultRegistry;
  health: HealthRegistry;
  logger: RuntimeLogger;
  /** Clock override (tests). */
  now?: () => number;
  /** Injectable source assembly seam for deterministic snapshot tests. */
  assembleEntries?: (opts: AssembleOptions) => Promise<SourceEntry[]>;
  /**
   * Injectable registration seam (tests). `createSnapshot` returning `null`
   * ("nothing changed — registered nothing") is the state the base-registration
   * invariant turns on, and no arrangement of REAL sources can force it while a
   * base is unanchored — the engine's own no-change test compares the sealed
   * `walGeneration`, so a live pending generation always differs from the
   * previous manifest's. The invariant must not DEPEND on that (it is a
   * predicate in another package, last widened for an unrelated reason), so the
   * seam exists to hold this service to it directly.
   */
  snapshot?: typeof createSnapshot;
  /** Injectable provider (tests) — defaults to `buildBackupProvider(config.provider)`. */
  provider?: BackupProvider;
  storageConnections?: StorageConnectionStore;
  /** Shared confirmation store; CLI-only callers fall back to backup state. */
  recoveryKit?: RecoveryKitStateStore;
  /** Injectable target-independent CAS inventory seam (tests). */
  casReconcile?: typeof runCasOnlyReconciliation;
}

/**
 * A `restore()` result, plus — for a lazy/partial restore (issue #405 §5) — the
 * previews-first warm-pass outcome: `result.skippedBlobs` names the blobs left
 * remote-only, and `previewsWarm` reports how many tinies were pulled and the
 * time-to-usable-grid a new device waited. `previewsWarm` is absent on a full
 * restore (no `lazy` option).
 */
export type LazyRestoreResult = RestoreResult & { previewsWarm?: PreviewsWarmResult };

/**
 * The previews-first lazy restore option (issue #405 §5 / #439 R2): the remote
 * CAS tier that is both the per-blob skip oracle and the warm-pass source, plus
 * an optional bounded warm fan-out. Explicit callers (tests, the recovery UI)
 * pass it directly; `restore()` also AUTO-resolves one from the vault's own tier
 * when neither `lazy` nor `full` is given.
 */
export interface LazyRestoreOption {
  /** The vault's remote blob CAS — the skip oracle AND the warm-pass source. */
  remote: RemoteTier;
  /** Bounded warm-pass read-through fan-out (issue #405 §5/§7). */
  warmConcurrency?: number;
}

/** The home bundle's provider-declared promises for the five-metric contract
 *  (#436 §6) — Recovery window and Exit read these two fields. */
export interface HomeDiscovery {
  retention: Retention;
  restoreCostClass: 'free-egress' | 'metered-egress';
}

/**
 * The pre-start restore cost estimate (issue #439 R2) the metered-egress confirm
 * gate — and, later, the recovery UI's price card (#436 §5) — render WITHOUT
 * downloading a manifest. `costClass` is the provider-declared egress class
 * (`homeDiscovery`, PROTOCOL.md's `restoreCostClass` MUST finally getting a call
 * site); `undefined` when backup isn't configured. `fullBytes` is the selected
 * snapshot registry row's `totalBytes` — the whole-library download a `--full`
 * restore incurs — or `undefined` when no snapshot/target is resolvable yet. A
 * lazy restore defers every blob the remote CAS already holds, so its upfront
 * download is the DB + git-bundle + any blob the remote LACKS plus the warm
 * pass's tinies; that figure is NOT knowable from the row alone, so it is
 * deliberately not fabricated — `lazyAvailable` only reports whether the vault
 * has a durable remote tier (⇒ lazy is the default and defers the bulk).
 */
export interface RestoreEgressEstimate {
  costClass: 'free-egress' | 'metered-egress' | undefined;
  /** Seq of the snapshot the estimate (and a subsequent restore) would select. */
  seq: number | undefined;
  /** Whole-library download bytes for a `--full` restore, or undefined if unknown. */
  fullBytes: number | undefined;
  /** True when a durable remote CAS tier exists ⇒ restore is lazy-by-default. */
  lazyAvailable: boolean;
}

/**
 * The snapshot a restore (and its egress estimate) selects, from a newest-first
 * `listSnapshots` result (issue #439 R2): an explicit `seq`, else — for a `--at`
 * point-in-time restore — the newest snapshot AT OR BEFORE that instant (which
 * is exactly the base the WAL replay starts from), else the newest snapshot.
 * `createdAt` is epoch SECONDS on the wire; `pointInTimeMs` is epoch ms.
 */
function pickSnapshotRow(
  rows: SnapshotRow[],
  opts: { seq?: number; pointInTimeMs?: number },
): SnapshotRow | undefined {
  if (opts.seq !== undefined) return rows.find((r) => r.seq === opts.seq);
  if (opts.pointInTimeMs !== undefined) {
    return rows.find((r) => r.createdAt * 1000 <= opts.pointInTimeMs!);
  }
  return rows[0];
}

/** Discovery is stable per provider; a short TTL keeps the 10s status poll off
 *  the provider's `/v1/storage/provider` endpoint on every tick. */
const HOME_DISCOVERY_TTL_MS = 5 * 60 * 1000;

export class BackupService {
  private homeDiscoveryCache: { at: number; value: HomeDiscovery } | undefined;
  private readonly config: BackupConfig | undefined;
  private readonly backupDir: string;
  private readonly vaults: VaultRegistry;
  private readonly health: HealthRegistry;
  private readonly logger: RuntimeLogger;
  private readonly now: () => number;
  private readonly provider: BackupProvider | undefined;
  private readonly storageConnections: StorageConnectionStore | undefined;
  private readonly keyringPath: string;
  private readonly assembleEntries: (opts: AssembleOptions) => Promise<SourceEntry[]>;
  private readonly snapshot: typeof createSnapshot;
  private readonly casReconcile: typeof runCasOnlyReconciliation;
  private readonly recoveryKit: RecoveryKitStateStore | undefined;
  private keyring: Keyring | undefined;
  private timer: NodeJS.Timeout | undefined;
  private walTimer: NodeJS.Timeout | undefined;
  /** One drain pass at a time; ticks that land mid-pass are skipped. */
  private draining = false;
  /** Scheduled drain attempts are due independently per vault policy. */
  private readonly lastWalDrainAttemptMs = new Map<string, number>();
  /** Set by stop(): no new runs/drains may start (shutdown teardown follows). */
  private stopped = false;
  /** Serializes every run — "one at a time (no concurrent backups)". */
  private chain: Promise<void> = Promise.resolve();
  /** The vault/kind currently executing inside `chain`, if any — read by
   *  `isRunning()` (the `_gateway/backup` route's `running` flag). */
  private activeRun:
    | { vaultId: string; kind: 'backup' | 'verify' | 'restore-verify' | 'reconcile' }
    | undefined;

  constructor(opts: BackupServiceOptions) {
    this.config = opts.config;
    this.backupDir = opts.backupDir;
    this.vaults = opts.vaults;
    this.health = opts.health;
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
    this.provider =
      opts.provider ?? (this.config ? buildBackupProvider(this.config.provider) : undefined);
    this.storageConnections = opts.storageConnections;
    this.keyringPath = this.config?.keyringPath ?? path.join(this.backupDir, 'keyring.json');
    this.assembleEntries = opts.assembleEntries ?? assembleSourceEntries;
    this.snapshot = opts.snapshot ?? createSnapshot;
    this.casReconcile = opts.casReconcile ?? runCasOnlyReconciliation;
    this.recoveryKit = opts.recoveryKit;

    this.health.registerProbe('backups', async () => this.probe());
  }

  private async backend(): Promise<
    { provider: BackupProvider; providerRef: string; label: string; dynamic: boolean } | undefined
  > {
    return resolveBackupBackend({
      ...(this.config ? { config: this.config } : {}),
      ...(this.provider ? { provider: this.provider } : {}),
      ...(this.storageConnections ? { storageConnections: this.storageConnections } : {}),
    });
  }

  async configured(): Promise<{ configured: boolean; provider?: string }> {
    const backend = await this.backend();
    return backend ? { configured: true, provider: backend.label } : { configured: false };
  }

  /**
   * The home bundle's provider-declared promises the five-metric contract
   * (#436 §6) reads for Recovery window (`retention`) and Exit
   * (`restoreCostClass`) — sourced from the discovery document
   * (`GET /v1/storage/provider`, PROTOCOL.md § Layer 2 — backup). Cached for
   * `HOME_DISCOVERY_TTL_MS` so the 10s status poll doesn't re-hit the provider
   * each time. `undefined` when backup isn't configured (no provider to ask).
   */
  async homeDiscovery(): Promise<HomeDiscovery | undefined> {
    const backend = await this.backend();
    if (!backend) return undefined;
    const at = this.now();
    const cached = this.homeDiscoveryCache;
    if (cached && at - cached.at < HOME_DISCOVERY_TTL_MS) return cached.value;
    const caps = await backend.provider.capabilities();
    const value: HomeDiscovery = caps.backup
      ? { retention: caps.backup.retention, restoreCostClass: caps.backup.restoreCostClass }
      : { retention: { kind: 'none' }, restoreCostClass: 'free-egress' };
    this.homeDiscoveryCache = { at, value };
    return value;
  }

  private async probe(): Promise<{ status: 'ok' | 'degraded' | 'error'; detail?: string }> {
    const state = await loadBackupState(this.backupDir);
    const backend = await this.backend();
    const backup = backend
      ? evaluateBackupHealth({
          state,
          policyForVault: (vaultId) => this.policyForVault(vaultId),
          now: this.now(),
        })
      : { status: 'ok' as const, detail: 'backup is not configured' };
    const casErrors: string[] = [];
    const casWarnings: string[] = [];
    for (const [vaultId, reconciliation] of Object.entries(state.casReconciliations)) {
      const detail =
        `${vaultId}: remote CAS inventory ${reconciliation.status} — ` +
        `${reconciliation.cas.missing.count} missing/corrupt, ` +
        `${reconciliation.cas.orphans.count} orphan(s)`;
      if (reconciliation.status === 'error') casErrors.push(detail);
      else if (reconciliation.status === 'degraded') casWarnings.push(detail);
      const staleMs = this.policyForVault(vaultId).verifyEveryDays * DAY_MS * 2;
      if (this.now() - Date.parse(reconciliation.checkedAt) >= staleMs) {
        casWarnings.push(`${vaultId}: remote CAS inventory reconciliation is stale`);
      }
    }
    if (backup.status === 'error' || casErrors.length > 0) {
      return {
        status: 'error',
        detail: [
          ...(backup.status === 'error' && backup.detail ? [backup.detail] : []),
          ...casErrors,
        ].join('; '),
      };
    }
    if (backup.status === 'degraded' || casWarnings.length > 0) {
      return {
        status: 'degraded',
        detail: [
          ...(backup.status === 'degraded' && backup.detail ? [backup.detail] : []),
          ...casWarnings,
        ].join('; '),
      };
    }
    return backup;
  }

  private policyForVault(vaultId: string): BackupPolicy {
    const plane = this.vaults.get(vaultId);
    return plane ? readBackupPolicy(plane.db.vault) : DEFAULT_BACKUP_POLICY;
  }

  private async ensureKeyring(): Promise<Keyring> {
    if (this.keyring) return this.keyring;
    try {
      this.keyring = await loadKeyring(this.keyringPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.keyring = await createKeyring(this.keyringPath);
      this.logger.info(`backup: minted a fresh keyring at ${this.keyringPath}`);
    }
    return this.keyring;
  }

  private assertTargetBackend(
    target: BackupTargetState,
    backend: { providerRef: string; dynamic: boolean },
  ): void {
    if (target.providerRef ? target.providerRef !== backend.providerRef : backend.dynamic) {
      throw new Error(
        'backup destination changed; refusing to use the prior target through a different provider',
      );
    }
  }

  /** Serialize `fn` after every run already queued. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private assertRunning(): void {
    if (this.stopped) throw new Error('backup service is stopped');
  }

  // ── Provider policy ─────────────────────────────────────────────────

  /** Push one vault's desired wire-policy, serialized with every state writer. */
  async syncPolicy(vaultId: string): Promise<ProviderPolicySyncState> {
    this.assertRunning();
    const plane = this.vaults.get(vaultId);
    if (!plane) throw new Error(`backup: unknown vault "${vaultId}"`);
    const desired = providerPolicyFor(readBackupPolicy(plane.db.vault));
    let result: ProviderPolicySyncState = {
      status: 'pending',
      desired,
      checkedAt: new Date(this.now()).toISOString(),
    };
    await this.enqueue(async () => {
      const state = await loadBackupState(this.backupDir);
      const target = state.targets[vaultId];
      if (!target) return;
      const backend = await this.backend();
      if (!backend) {
        target.providerPolicy = result;
        await saveBackupState(this.backupDir, state);
        return;
      }
      this.assertTargetBackend(target, backend);
      result = await pushProviderPolicy({
        provider: backend.provider,
        targetId: target.targetId,
        desired,
        checkedAt: new Date(this.now()).toISOString(),
      });
      target.providerPolicy = result;
      await saveBackupState(this.backupDir, state);
    });
    return result;
  }

  private async syncEnabledPolicies(): Promise<void> {
    const state = await loadBackupState(this.backupDir);
    for (const plane of this.vaults.planesList()) {
      const vaultId = plane.boot.vaultId;
      if (!state.targets[vaultId]) continue;
      this.attachSnapshotRoots(plane);
      await this.syncPolicy(vaultId);
    }
  }

  /**
   * Wire a vault plane's blob sweep to the retained-snapshot GC roots (issue
   * #436 §6). The plane's client-owned CAS orphan-delete consults this before
   * every sweep so it can never evict an object a recovery-to-N still needs.
   * The closure re-reads the current target each call (target id can change),
   * and throws on any read/authenticate failure — the sweep translates that
   * into skipping the delete phase (fail safe, never fail open). Idempotent:
   * setting it again on an already-wired plane is harmless.
   */
  private attachSnapshotRoots(plane: VaultPlane): void {
    const vaultId = plane.boot.vaultId;
    plane.snapshotBlobRoots = async (): Promise<ReadonlySet<string>> => {
      const backend = await this.backend();
      if (!backend) return new Set<string>();
      const state = await loadBackupState(this.backupDir);
      const target = state.targets[vaultId];
      // No target ⇒ no registered snapshots for this vault ⇒ no roots to pin.
      if (!target) return new Set<string>();
      return snapshotReferencedBlobShas({
        provider: backend.provider,
        targetId: target.targetId,
        vaultId,
        keyring: await this.ensureKeyring(),
        manifestBlobCache: this.manifestBlobCache,
      });
    };
  }

  // ── Backup ────────────────────────────────────────────────────────────

  async runBackup(vaultId: string): Promise<void> {
    this.assertRunning();
    return this.enqueue(async () => {
      this.activeRun = { vaultId, kind: 'backup' };
      try {
        await this.doRunBackup(vaultId);
      } finally {
        this.activeRun = undefined;
      }
    });
  }

  /**
   * Manual "run every mounted vault now" — the CLI's `backup run` (no
   * `--vault`) and the Gateway page's "Back up now" button. Unlike `tick()`,
   * bypasses the due-ness check: every mounted vault backs up immediately,
   * one at a time (the same `chain` serialization `runBackup` always uses).
   */
  async runAll(): Promise<void> {
    this.assertRunning();
    for (const plane of this.vaults.planesList()) {
      await this.runBackup(plane.boot.vaultId);
    }
  }

  /** Is a backup/verify run currently executing? Scoped to `vaultId` when
   *  given, otherwise true if ANY vault is mid-run (`chain` only ever runs
   *  one at a time). */
  isRunning(vaultId?: string): boolean {
    if (!this.activeRun) return false;
    return vaultId === undefined || this.activeRun.vaultId === vaultId;
  }

  private async doRunBackup(vaultId: string): Promise<void> {
    const backend = await this.backend();
    if (!backend) throw new Error('backup is not configured — add a provider backup connection');
    const plane = this.vaults.get(vaultId);
    if (!plane) {
      this.logger.warn(`backup: unknown vault "${vaultId}" — skipped`);
      return;
    }
    const state = await loadBackupState(this.backupDir);
    let target = state.targets[vaultId];
    if (target?.fenced) {
      this.logger.warn(
        `backup: vault ${vaultId} is fenced (another machine took over) — refusing to auto-backup`,
      );
      return;
    }
    if (
      target &&
      (target.providerRef ? target.providerRef !== backend.providerRef : backend.dynamic)
    ) {
      const message =
        'backup destination changed; refusing to reuse the prior target automatically';
      target.lastError = message;
      state.targets[vaultId] = target;
      await saveBackupState(this.backupDir, state);
      this.health.reportError('backups', `vault ${vaultId}: ${message}`);
      throw new Error(message);
    }
    const keyring = await this.ensureKeyring();
    let createdTarget = false;
    if (!target) {
      const label = opaqueLabel();
      const { targetId } = await backend.provider.createTarget({ label });
      target = {
        targetId,
        label,
        generation: 1,
        providerRef: backend.providerRef,
        // Target persistence precedes the first (possibly long) snapshot.
        // This timestamp gives health checks an honest fresh-target grace.
        firstBackupAt: new Date(this.now()).toISOString(),
      };
      createdTarget = true;
      state.targets[vaultId] = target;
      await saveBackupState(this.backupDir, state);
    }
    // Pin this vault's blob sweep to its retained-snapshot GC roots (issue
    // #436 §6) the moment a target exists — before the first snapshot lands, so
    // no orphan-delete can ever race ahead of the reachability set.
    this.attachSnapshotRoots(plane);
    const desiredPolicy = providerPolicyFor(readBackupPolicy(plane.db.vault));
    if (
      createdTarget ||
      !target.providerPolicy ||
      !providerPolicyMatches(target.providerPolicy.desired, desiredPolicy)
    ) {
      target.providerPolicy = await pushProviderPolicy({
        provider: backend.provider,
        targetId: target.targetId,
        desired: desiredPolicy,
        checkedAt: new Date(this.now()).toISOString(),
      });
      state.targets[vaultId] = target;
      await saveBackupState(this.backupDir, state);
    }

    // Capture NOW: on a fresh vault this mints the first generations (and
    // their bases); on a running one it ships the newest committed bytes so
    // the snapshot being registered is as current as one tick allows. This
    // lives HERE, not inside assembleSourceEntries — the assemble seam is
    // injectable (tests), and a listing function must not be the only thing
    // standing between a backup run and a checkpoint.
    const shipper = plane.walShipper;
    plane.walTick();
    if (!shipper) {
      target.lastError = 'backup: WAL shipper is unavailable';
      state.targets[vaultId] = target;
      await saveBackupState(this.backupDir, state);
      throw new Error(target.lastError);
    }
    if (shipper.discardedStreams().length > 0 || !shipper.basesCoordinated()) {
      throw new Error(
        'backup: WAL generation is discarded or mid-break — retrying instead of registering a holed base',
      );
    }

    // Issue #411 action 1: fold the shipper's foreign-checkpoint tally into THIS
    // in-memory `target`. NOT via `syncWalForeignCheckpoints` (a separate fresh
    // load+save): the register path re-saves `state` several times below, which
    // would clobber a separately-written counter. The drain pass uses the helper
    // because there its save is the last write of the vault's turn.
    const shipStatus = shipper.status();
    if (shipStatus.foreignCheckpointCount > 0) {
      target.walForeignCheckpointCount = shipStatus.foreignCheckpointCount;
      if (shipStatus.lastForeignCheckpoint) {
        target.walLastForeignCheckpoint = { ...shipStatus.lastForeignCheckpoint };
      }
    }

    // Issue #408: pin each WAL generation to ONE keyring epoch — AFTER the
    // tick, so a generation the tick just minted gets pinned before its
    // manifest registers. A rotation breaks the streams to fresh
    // generations BEFORE anything else, so a generation's manifest and its
    // segments always share an epoch — restore derives the segment key
    // from the manifest's `keyEpoch`.
    if (shipper) {
      const pins = (target.walGenerationEpochs ??= {});
      const bases = shipper.currentBases();
      // ONE roll re-bases BOTH databases now (the two generations break
      // together — a manifest may never pair bases from two ticks), so this is
      // deliberately NOT a per-base loop: rolling once per stale base would
      // mint, and immediately retire, a whole extra generation per rotation.
      const stale = bases.find(
        (b) => pins[b.generation] !== undefined && pins[b.generation] !== keyring.active,
      );
      if (stale) {
        shipper.rollGeneration(stale.db, 'key-epoch-rotation');
        const fresh = shipper.currentBases();
        const unrolled = fresh.some((b) =>
          bases.some((old) => old.db === b.db && old.generation === b.generation),
        );
        if (unrolled) {
          // The roll's checkpoint came back busy — an OLD generation is still
          // live. Re-pinning IT to the new epoch would seal its remaining
          // segments under a key its manifest doesn't name (undecryptable at
          // restore). Retry the whole run later.
          throw new Error(
            'backup: the key-epoch rotation roll did not complete (busy checkpoint) — retrying later',
          );
        }
        for (const base of fresh) pins[base.generation] = keyring.active;
      } else {
        for (const base of bases) pins[base.generation] ??= keyring.active;
      }
      state.targets[vaultId] = target;
      await saveBackupState(this.backupDir, state);
    }

    // The newest pair marker THIS provider has confirmed accepting for the
    // shipper's current base pair. Stamped into the manifest, where it becomes
    // a floor the store is held to at every later verification — which is the
    // only thing that makes deleting the `wal/tick/` prefix visible at all.
    const walTipTickMs = shipper ? this.confirmedMarkerTip(shipper, target) : undefined;

    const stagingDir = path.join(this.backupDir, 'staging', vaultId);
    await resetStagingDir(stagingDir);
    try {
      const entries = await this.assembleEntries({
        plane,
        stagingDir,
        ...(walTipTickMs !== undefined ? { walTipTickMs } : {}),
        log: { info: (m) => this.logger.info(m), warn: (m) => this.logger.warn(m) },
      });
      const row = await this.snapshot({
        provider: backend.provider,
        targetId: target.targetId,
        keyring,
        vaultId,
        entries,
        generation: target.generation,
        appMeta: this.appMetaFor(plane, state.sourceInstanceId),
        log: { info: (m) => this.logger.info(m), warn: (m) => this.logger.warn(m) },
      });
      const completedAt = new Date(this.now()).toISOString();
      target.firstBackupAt ??= completedAt;
      target.lastBackupAt = completedAt;
      if (row) target.lastSeq = row.seq;
      delete target.lastError;
      state.targets[vaultId] = target;
      await saveBackupState(this.backupDir, state);
      if (shipper) {
        // A registered manifest anchors the current bases — the shipper may
        // now treat those generations as restorable. `basePending` is what
        // makes the drain pass keep RETRYING registration
        // (`needsRegistration`), so clearing it for a generation no manifest
        // names is the quietest data loss in the system: the retries stop, the
        // generation's segments keep uploading under a generation nothing
        // references, and the next prune — whose keep-set is built from
        // authenticated manifests — deletes them. Everything written since the
        // last real manifest is gone, and every surface still reads green.
        //
        // So it is ONLY ever cleared for a generation a manifest demonstrably
        // names. `row` is such a manifest: `createSnapshot` just sealed it from
        // exactly these entries. A NULL row registered nothing at all, and the
        // anchor — if there is one — is the previous manifest, which we go READ
        // rather than assume. (It is not enough that `createSnapshot`'s
        // no-change test happens to imply an anchor today: that predicate lives
        // in another package and was last widened for an unrelated reason. This
        // invariant must hold on its own.)
        const dbEntries = entries.filter(
          (e): e is SourceEntry & { walGeneration: string } =>
            e.kind === 'db' && e.walGeneration !== undefined,
        );
        const anchored = row
          ? new Set(dbEntries.map((e) => e.walGeneration))
          : await this.manifestAnchoredGenerations(
              backend.provider,
              target.targetId,
              keyring,
              vaultId,
            );
        // Any generation a manifest names is also epoch-pinned NOW (the
        // manifest sealed under `keyring.active`): a pin deferred to the
        // next drain could land after an offline keyring rotation and seal
        // the generation's segments under a different epoch than its
        // manifest — unreadable at restore.
        target.walGenerationEpochs ??= {};
        let pinsDirty = false;
        for (const entry of dbEntries) {
          if (!anchored.has(entry.walGeneration)) {
            this.logger.warn(
              `backup: no manifest anchors ${entry.path}'s generation ${entry.walGeneration} — ` +
                'leaving its base PENDING so registration keeps retrying (a base marked ' +
                'registered without a manifest loses every restore point since the last one)',
            );
            continue;
          }
          const db = entry.path === 'vault.db' ? 'vault' : 'journal';
          shipper.noteBaseRegistered(db, entry.walGeneration);
          if (target.walGenerationEpochs[entry.walGeneration] === undefined) {
            target.walGenerationEpochs[entry.walGeneration] = keyring.active;
            pinsDirty = true;
          }
        }
        if (pinsDirty) {
          state.targets[vaultId] = target;
          await saveBackupState(this.backupDir, state);
        }
        // Client-side GC of segment objects for generations nothing
        // references anymore (best-effort — never fails the backup run).
        try {
          const pruned = await pruneWalGenerations({
            plane,
            provider: backend.provider,
            targetId: target.targetId,
            keyring,
            vaultId,
            manifestGenerationCache: this.manifestGenerationCache,
            logger: this.logger,
          });
          if (target.walGenerationEpochs) {
            for (const gen of Object.keys(target.walGenerationEpochs)) {
              if (!pruned.keptGenerations.has(gen)) delete target.walGenerationEpochs[gen];
            }
          }
          if (target.walMarkerTips) {
            // A pair key names BOTH generations; the tip dies with either of them.
            for (const pair of Object.keys(target.walMarkerTips)) {
              const [vaultGen, journalGen] = [pair.slice(0, 32), pair.slice(33)];
              if (
                !pruned.keptGenerations.has(vaultGen) ||
                !pruned.keptGenerations.has(journalGen)
              ) {
                delete target.walMarkerTips[pair];
              }
            }
          }
          if (target.walGenerationEpochs || target.walMarkerTips) {
            state.targets[vaultId] = target;
            await saveBackupState(this.backupDir, state);
          }
        } catch (err) {
          this.logger.warn(
            `backup: wal prune failed (kept everything): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      this.health.reportOk(
        'backups',
        row
          ? `vault ${vaultId}: backed up (seq ${row.seq})`
          : `vault ${vaultId}: no change since last backup`,
      );
    } catch (err) {
      if (err instanceof BackupProviderError && err.code === 'conflict_generation') {
        // PROTOCOL.md § Generation fencing: never retry with a bumped
        // generation automatically — surface loudly and stop.
        target.fenced = true;
        target.lastError =
          'another machine has taken over this vault (conflict_generation) — backups stopped';
        state.targets[vaultId] = target;
        await saveBackupState(this.backupDir, state);
        this.health.reportError('backups', `vault ${vaultId}: ${target.lastError}`);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      target.lastError = message;
      state.targets[vaultId] = target;
      await saveBackupState(this.backupDir, state);
      this.health.reportError('backups', `vault ${vaultId}: backup failed: ${message}`);
      throw err;
    } finally {
      await resetStagingDir(stagingDir).catch(() => undefined);
    }
  }

  /**
   * The confirmed marker tip for the shipper's CURRENT base pair, or undefined
   * when no marker of this pair has drained yet (a freshly broken generation).
   * Keyed by the pair, so a generation break resets the floor rather than
   * carrying a stale one into a stream that cannot possibly satisfy it.
   */
  private confirmedMarkerTip(
    shipper: NonNullable<VaultPlane['walShipper']>,
    target: BackupTargetState,
  ): number | undefined {
    const bases = shipper.currentBases();
    const vault = bases.find((b) => b.db === 'vault');
    const journal = bases.find((b) => b.db === 'journal');
    if (!vault || !journal) return undefined;
    return target.walMarkerTips?.[walPairKey(vault.generation, journal.generation)];
  }

  /**
   * Issue #411 action 1: copy the shipper's foreign-checkpoint tally into the
   * persisted target when it has advanced. Mirrors the `lastRestoreVerify*` /
   * `lastError` pattern — sticky signals live in persisted `BackupTargetState`
   * so the health probe recomputes them from state rather than a pushed report
   * the next probe would overwrite. Called after every WAL tick this service
   * drives (the drain pass at `walTimer` cadence, and a manual backup run), and
   * idempotent: it reads a FRESH state, no-ops when nothing changed, and merges
   * only these two fields so concurrent runs cannot clobber each other.
   */
  private async syncWalForeignCheckpoints(
    vaultId: string,
    shipper: NonNullable<VaultPlane['walShipper']>,
  ): Promise<void> {
    const st = shipper.status();
    if (st.foreignCheckpointCount === 0) return; // nothing ever detected
    const fresh = await loadBackupState(this.backupDir);
    const target = fresh.targets[vaultId];
    if (!target) return; // no target yet — nothing to hang the signal on
    if (
      target.walForeignCheckpointCount === st.foreignCheckpointCount &&
      target.walLastForeignCheckpoint?.atMs === st.lastForeignCheckpoint?.atMs
    ) {
      return; // already persisted — avoid a needless state write per tick
    }
    target.walForeignCheckpointCount = st.foreignCheckpointCount;
    if (st.lastForeignCheckpoint) {
      target.walLastForeignCheckpoint = {
        atMs: st.lastForeignCheckpoint.atMs,
        db: st.lastForeignCheckpoint.db,
        reason: st.lastForeignCheckpoint.reason,
      };
    }
    await saveBackupState(this.backupDir, fresh);
  }

  private appMetaFor(plane: VaultPlane, sourceInstanceId: string): Record<string, string> {
    const row = plane.db.vault.prepare('PRAGMA user_version').get() as
      | { user_version: number }
      | undefined;
    return {
      gatewayVersion: GATEWAY_VERSION,
      vaultUserVersion: String(row?.user_version ?? VAULT_MIGRATIONS.length),
      ontologyVersion: ONTOLOGY_VERSION,
      sourceInstanceId,
    };
  }

  // ── Verify ────────────────────────────────────────────────────────────

  async runVerify(vaultId: string): Promise<VerifySnapshotResult | undefined> {
    this.assertRunning();
    let result: VerifySnapshotResult | undefined;
    await this.enqueue(async () => {
      this.activeRun = { vaultId, kind: 'verify' };
      try {
        result = await this.doRunVerify(vaultId);
      } finally {
        this.activeRun = undefined;
      }
    });
    return result;
  }

  /** Manual integrity check for every vault that already has a snapshot. */
  async verifyAll(): Promise<void> {
    this.assertRunning();
    const state = await loadBackupState(this.backupDir);
    for (const plane of this.vaults.planesList()) {
      if (state.targets[plane.boot.vaultId]) await this.runVerify(plane.boot.vaultId);
    }
  }

  private async doRunVerify(vaultId: string): Promise<VerifySnapshotResult | undefined> {
    const backend = await this.backend();
    if (!backend) throw new Error('backup is not configured — add a provider backup connection');
    const state = await loadBackupState(this.backupDir);
    const target = state.targets[vaultId];
    if (!target) {
      this.logger.warn(`backup verify: vault ${vaultId} has no backup target yet — skipped`);
      return undefined;
    }
    this.assertTargetBackend(target, backend);
    const keyring = await this.ensureKeyring();
    try {
      const result = await verifySnapshot({
        provider: backend.provider,
        targetId: target.targetId,
        keyring,
        vaultId,
      });
      if (result.missing.length > 0 || result.corrupt.length > 0) {
        target.lastVerifyError = `verify found ${result.missing.length} missing, ${result.corrupt.length} corrupt object(s)`;
        this.health.reportError(
          'backups',
          `vault ${vaultId}: verify found ${result.missing.length} missing, ${result.corrupt.length} corrupt object(s)`,
        );
      } else {
        target.lastVerifiedAt = new Date(this.now()).toISOString();
        delete target.lastVerifyError;
        this.health.reportOk(
          'backups',
          `vault ${vaultId}: verify ok (${result.checkedObjects} checked, ${result.sampled} sampled)`,
        );
      }
      state.targets[vaultId] = target;
      await saveBackupState(this.backupDir, state);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      target.lastVerifyError = `verify failed: ${message}`;
      state.targets[vaultId] = target;
      await saveBackupState(this.backupDir, state);
      this.health.reportError('backups', `vault ${vaultId}: verify failed: ${message}`);
      throw err;
    }
  }

  // ── Inventory reconciliation (issue #414 D14) ───────────────────────

  async runReconciliation(
    vaultId: string,
    opts: { verifyBucket?: boolean } = {},
  ): Promise<BackupReconciliationState | undefined> {
    this.assertRunning();
    let result: BackupReconciliationState | undefined;
    await this.enqueue(async () => {
      this.activeRun = { vaultId, kind: 'reconcile' };
      try {
        result = await this.doRunReconciliation(vaultId, opts.verifyBucket ?? false);
      } finally {
        this.activeRun = undefined;
      }
    });
    return result;
  }

  /** Owner action: independently LIST the bucket and cross-check provider attestation. */
  async verifyAgainstBucket(vaultId: string): Promise<BackupReconciliationState | undefined> {
    return this.runReconciliation(vaultId, { verifyBucket: true });
  }

  private async doRunReconciliation(
    vaultId: string,
    verifyBucket: boolean,
  ): Promise<BackupReconciliationState | undefined> {
    const plane = this.vaults.get(vaultId);
    if (!plane) throw new Error(`backup: unknown vault "${vaultId}"`);
    const state = await loadBackupState(this.backupDir);
    const target = state.targets[vaultId];
    const backend = await this.backend();
    const checkedAt = new Date(this.now()).toISOString();
    let summary: BackupReconciliationState;
    if (backend && target) {
      this.assertTargetBackend(target, backend);
      const desired = providerPolicyFor(readBackupPolicy(plane.db.vault));
      if (
        target.providerPolicy?.status !== 'rejected' ||
        !providerPolicyMatches(target.providerPolicy.desired, desired)
      ) {
        target.providerPolicy = await inspectProviderPolicy({
          provider: backend.provider,
          targetId: target.targetId,
          desired,
          checkedAt,
        });
      }
      try {
        target.reconciliation = await runBackupReconciliation({
          provider: backend.provider,
          targetId: target.targetId,
          vaultId,
          keyring: await this.ensureKeyring(),
          db: plane.db,
          ...(this.storageConnections ? { storageConnections: this.storageConnections } : {}),
          ...(target.walMarkerTips ? { walMarkerTips: target.walMarkerTips } : {}),
          manifestBlobCache: this.manifestBlobCache,
          verifyBucket,
          checkedAt,
        });
      } catch (err) {
        target.reconciliation = failedReconciliation(
          checkedAt,
          verifyBucket ? 'bucket' : 'scheduled',
          err instanceof Error ? err.message : String(err),
        );
      }
      summary = target.reconciliation;
      state.targets[vaultId] = target;
      delete state.casReconciliations[vaultId];
    } else {
      if (readBlobStoreSettings(plane.db.vault).kind !== 's3') {
        this.logger.info(`backup reconcile: vault ${vaultId} has no remote store — skipped`);
        return undefined;
      }
      try {
        summary = await this.casReconcile({
          db: plane.db,
          ...(this.storageConnections ? { storageConnections: this.storageConnections } : {}),
          verifyBucket,
          checkedAt,
        });
      } catch (err) {
        summary = failedCasOnlyReconciliation(
          checkedAt,
          verifyBucket ? 'bucket' : 'scheduled',
          err instanceof Error ? err.message : String(err),
        );
      }
      state.casReconciliations[vaultId] = summary;
    }
    await saveBackupState(this.backupDir, state);
    const detail =
      `vault ${vaultId}: inventory ${summary.status} — ` +
      `${summary.cas.missing.count} CAS missing, ${summary.backup.missing.count} backup missing, ` +
      `${summary.walGaps.count} WAL gap(s), ` +
      `${summary.cas.orphans.count + summary.backup.orphans.count} orphan(s)`;
    if (summary.status === 'error') this.health.reportError('backups', detail);
    else if (summary.status === 'degraded') this.health.reportDegraded('backups', detail);
    else this.health.reportOk('backups', detail);
    return summary;
  }

  // ── Restore verification (issue #408 G9) ────────────────────────────

  /**
   * A REAL restore from the remote into a scratch directory, then every
   * check the acceptance criteria name: base sha + chunk integrity + WAL
   * replay (all inside `restoreSnapshot`), `integrity_check` /
   * `foreign_key_check`, and the G8 cross-database receipt check. A backup
   * that has never been restored is a hypothesis — this is what turns it
   * into a fact, on a clock.
   */
  async runRestoreVerify(vaultId: string): Promise<void> {
    this.assertRunning();
    return this.enqueue(async () => {
      this.activeRun = { vaultId, kind: 'restore-verify' };
      try {
        await this.doRunRestoreVerify(vaultId);
      } finally {
        this.activeRun = undefined;
      }
    });
  }

  private async doRunRestoreVerify(vaultId: string): Promise<void> {
    const backend = await this.backend();
    if (!backend) throw new Error('backup is not configured — add a provider backup connection');
    const state = await loadBackupState(this.backupDir);
    const target = state.targets[vaultId];
    if (!target || target.lastSeq === undefined) {
      this.logger.info(`backup restore-verify: vault ${vaultId} has no snapshot yet — skipped`);
      return;
    }
    this.assertTargetBackend(target, backend);
    const keyring = await this.ensureKeyring();
    const destDir = path.join(this.backupDir, 'restore-verify', `${vaultId}-${this.now()}`);
    try {
      const result = await restoreSnapshot({
        provider: backend.provider,
        targetId: target.targetId,
        keyring,
        vaultId,
        destDir,
        current: {
          gatewayVersion: GATEWAY_VERSION,
          vaultUserVersion: String(VAULT_MIGRATIONS.length),
          ontologyVersion: ONTOLOGY_VERSION,
        },
        log: { info: (m) => this.logger.info(m), warn: (m) => this.logger.warn(m) },
      });
      const report = verifyRestoredPair(destDir);
      const problems: string[] = [];
      if (report.vault.integrity !== 'ok') problems.push(`vault: ${report.vault.integrity}`);
      if (report.journal.integrity !== 'ok') problems.push(`journal: ${report.journal.integrity}`);
      if (report.vault.foreignKeyViolations > 0) {
        problems.push(`vault: ${report.vault.foreignKeyViolations} fk violation(s)`);
      }
      if (report.journal.foreignKeyViolations > 0) {
        problems.push(`journal: ${report.journal.foreignKeyViolations} fk violation(s)`);
      }
      if (result.walReplay) {
        const { damaged, coordinatedCutMs, expectedCutMs } = result.walReplay;
        if (damaged.length > 0) problems.push(`${damaged.length} damaged wal object(s) skipped`);
        else if (expectedCutMs >= 0 && coordinatedCutMs < expectedCutMs) {
          // The restore SUCCEEDED — coherently, at an earlier instant (G6). It
          // is simply not allowed to be QUIET about it. `expectedCutMs` is the
          // newest tick this store either proved (a surviving pair marker) or
          // ACKNOWLEDGED (the tip this snapshot registered after watching the
          // PUTs land). Falling short of it means objects are gone — and if the
          // gone objects are the markers themselves, this is the ONLY check
          // that fires: nothing is missing, nothing is damaged, and the restore
          // just silently hands back an hours-old vault.
          problems.push(
            'wal streams not restorable at their newest registered point (tick ' +
              `${expectedCutMs}); the pair could only be cut at ${coordinatedCutMs} — ` +
              'objects the provider acknowledged are missing',
          );
        }
      }
      if (problems.length > 0) {
        this.health.reportError(
          'backups',
          `vault ${vaultId}: restore-verify FAILED: ${problems.join('; ')}`,
        );
        throw new Error(`restore-verify failed: ${problems.join('; ')}`);
      }
      // Dangling receipts are a signal, not proof of a bad restore: vault
      // rows may be legitimately hard-deleted after their receipt (see
      // verifyRestoredPair) — degraded, human review. PERSISTED, because the
      // health probe recomputes from backup state and its verdict overrides
      // pushed reports; a degrade that only ever lived in a pushed report
      // would go green at the next probe.
      const dangling = report.danglingReceipts.length;
      target.lastRestoreVerifiedAt = new Date(this.now()).toISOString();
      delete target.lastRestoreVerifyError;
      if (dangling > 0) target.lastRestoreVerifyDangling = dangling;
      else delete target.lastRestoreVerifyDangling;
      state.targets[vaultId] = target;
      await saveBackupState(this.backupDir, state);
      // Exactly ONE terminal health report per outcome: an ok pushed after a
      // degrade erases the degrade, so the run's whole verdict is decided
      // here and reported once.
      const ran =
        `vault ${vaultId}: restore-verify (seq ${result.seq}, ` +
        `${report.receiptsChecked} receipts cross-checked` +
        (result.walReplay
          ? `, wal tip ${result.walReplay.perDb.vault.lastTickMs}`
          : ', /1 snapshot') +
        ')';
      if (dangling > 0) {
        this.health.reportDegraded(
          'backups',
          `${ran}: ${dangling} receipt(s) reference absent vault rows — ` +
            'hard-deletes explain this; anything else needs eyes',
        );
      } else {
        this.health.reportOk('backups', `${ran}: ok`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Persist the failure: the health probe recomputes from backup STATE
      // at every snapshot (overriding pushed reports), so an unpersisted
      // failure would show green health over provably damaged backups.
      target.lastRestoreVerifyError = message;
      state.targets[vaultId] = target;
      await saveBackupState(this.backupDir, state).catch(() => undefined);
      this.health.reportError('backups', `vault ${vaultId}: restore-verify failed: ${message}`);
      throw err;
    } finally {
      await fs.rm(destDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ── WAL segment drain (issue #408) ───────────────────────────────────

  /** In-memory backoff for auto-triggered base registrations. */
  private lastAutoBackupAttemptMs = new Map<string, number>();
  /** `manifestHash → walGenerations` memo for the prune's keep-set. */
  private readonly manifestGenerationCache = new Map<string, string[]>();
  /** `manifestHash → blob shas` memo for the retained-snapshot GC roots (#436 §6). */
  private readonly manifestBlobCache = new Map<string, string[]>();

  /**
   * Every WAL generation an AUTHENTICATED manifest on the provider names —
   * the same source of truth `pruneWalGenerations` builds its keep-set from,
   * and the only thing allowed to clear a base's `basePending` flag. Manifests
   * are immutable and content-addressed, so the memo means only NEW ones are
   * ever fetched.
   *
   * Read failures return what was readable and never throw: this only runs on
   * a no-change run (the manifest we could not read anchors nothing new), and
   * the conservative outcome is a base that stays PENDING and gets retried.
   */
  private async manifestAnchoredGenerations(
    provider: BackupProvider,
    targetId: string,
    keyring: Keyring,
    vaultId: string,
  ): Promise<Set<string>> {
    const anchored = new Set<string>();
    try {
      const rows = await provider.listSnapshots(targetId);
      const store = await provider.openDataPlane(targetId, 'backup', 'read');
      for (const row of rows) {
        let generations = this.manifestGenerationCache.get(row.manifestHash);
        if (!generations) {
          const opened = openManifest(
            await store.get(row.manifestKey),
            keyring,
            vaultId,
            row.manifestHash,
          );
          generations = opened.entries
            .map((entry) => entry.walGeneration)
            .filter((gen): gen is string => gen !== undefined);
          this.manifestGenerationCache.set(row.manifestHash, generations);
        }
        for (const gen of generations) anchored.add(gen);
      }
    } catch (err) {
      this.logger.warn(
        `backup: could not read the registered manifests to confirm which generations they ` +
          `anchor (bases stay pending, registration retries): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return anchored;
  }

  /**
   * One drain pass over every mounted vault. Public for tests + manual
   * runs. Runs ON THE CHAIN: every reader-modifier of the backup state file
   * is serialized (a drain that saved a stale snapshot over a concurrent
   * restore-verify's persisted failure would flip health green over
   * provably damaged backups), and `stop()`'s chain await therefore covers
   * in-flight drains too.
   */
  async drainWal(vaultIds?: ReadonlySet<string>): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      await this.enqueue(() => this.doDrainPass(vaultIds));
    } finally {
      this.draining = false;
    }
  }

  /** Scheduler entry: each vault's WAL drain follows its own declared RPO. */
  private async drainWalDue(): Promise<void> {
    if (this.draining || this.stopped) return;
    const now = this.now();
    const due = new Set<string>();
    for (const plane of this.vaults.planesList()) {
      const vaultId = plane.boot.vaultId;
      const rpoMs = readBackupPolicy(plane.db.vault).rpoSeconds * 1000;
      const last = this.lastWalDrainAttemptMs.get(vaultId) ?? 0;
      if (now - last < rpoMs) continue;
      this.lastWalDrainAttemptMs.set(vaultId, now);
      due.add(vaultId);
    }
    if (due.size > 0) await this.drainWal(due);
  }

  private async doDrainPass(vaultIds?: ReadonlySet<string>): Promise<void> {
    const backend = await this.backend();
    for (const plane of this.vaults.planesList()) {
      if (this.stopped) return;
      const shipper = plane.walShipper;
      if (!shipper) continue;
      const vaultId = plane.boot.vaultId;
      if (vaultIds && !vaultIds.has(vaultId)) continue;
      if (!backend) {
        // Capture-then-discard: the shipper must keep ticking (its
        // rollovers bound the WALs now that autocheckpoint is off), so
        // without a provider its output is consumed by deletion — and the
        // stream is marked holed (see discardWalFiles).
        discardWalFiles(plane);
        continue;
      }
      try {
        // A stream holed by capture-then-discard must break to a fresh
        // generation BEFORE its stale base could be registered: restoring
        // a holed stream silently lands on the base — quiet truncation. ONE
        // roll re-bases BOTH databases (generations break together), and
        // `rollGeneration` ships nothing out of a discarded stream, so naming
        // any one of them heals the pair.
        const discarded = shipper.discardedStreams();
        if (discarded.length > 0) {
          const rolled = shipper.rollGeneration(discarded[0]!, 'backup-enabled-after-discard', {
            captureFirst: false,
          });
          if (
            rolled.busy.length > 0 ||
            rolled.errors.length > 0 ||
            shipper.discardedStreams().length > 0 ||
            !shipper.basesCoordinated()
          ) {
            this.logger.warn(
              `backup: discarded WAL generation could not re-base cleanly; registration deferred`,
            );
            continue;
          }
        }
        let state = await loadBackupState(this.backupDir);
        let target = state.targets[vaultId];
        if (target?.fenced) continue;
        const needsRegistration = !target || shipper.pendingBases().length > 0;
        if (needsRegistration) {
          // A new generation (or a first-ever backup) needs its manifest
          // registered — a full backup run (already on the chain, so call
          // the worker directly), backed off so an unreachable provider
          // doesn't get hammered every drain tick.
          const last = this.lastAutoBackupAttemptMs.get(vaultId) ?? 0;
          if (this.now() - last >= 5 * 60 * 1000) {
            this.lastAutoBackupAttemptMs.set(vaultId, this.now());
            await this.doRunBackup(vaultId).catch((err) => {
              this.logger.warn(
                `backup: base registration for ${vaultId} failed (segments keep accumulating locally): ` +
                  `${err instanceof Error ? err.message : String(err)}`,
              );
            });
            state = await loadBackupState(this.backupDir);
            target = state.targets[vaultId];
          }
        }
        if (!target || target.fenced) continue;
        this.assertTargetBackend(target, backend);
        const keyring = await this.ensureKeyring();
        const newPins: Record<string, number> = {};
        const result = await drainWalFiles({
          plane,
          provider: backend.provider,
          targetId: target.targetId,
          keyring,
          vaultId,
          epochForGeneration: (generation) => {
            const pinned = target.walGenerationEpochs?.[generation] ?? newPins[generation];
            if (pinned !== undefined) return pinned;
            newPins[generation] = keyring.active;
            return keyring.active;
          },
          logger: this.logger,
        });
        {
          // Merge into a FRESH state read: the drain's uploads take long
          // enough that saving the pass's opening snapshot could clobber
          // fields other runs persisted meanwhile.
          const freshState = await loadBackupState(this.backupDir);
          const freshTarget = freshState.targets[vaultId];
          if (freshTarget) {
            freshTarget.lastWalDrainAt = new Date(this.now()).toISOString();
            freshTarget.walGenerationEpochs = {
              ...freshTarget.walGenerationEpochs,
              ...newPins,
            };
            // MONOTONIC per pair: the tip is a claim about what the provider
            // holds, and it may only ever grow within one base pair. A
            // late-landing retry of an older marker must not walk the floor
            // backwards and re-open the very window this closes.
            const tips = (freshTarget.walMarkerTips ??= {});
            for (const [pair, tickMs] of Object.entries(result.markerTips)) {
              tips[pair] = Math.max(tips[pair] ?? -1, tickMs);
            }
            await saveBackupState(this.backupDir, freshState);
          }
        }
        if (result.uploaded > 0) {
          this.logger.info(
            `backup: drained ${result.uploaded} wal object(s), ${result.bytes} sealed byte(s) (${vaultId})`,
          );
        }
        // Issue #411 action 1: the WAL ticks this pass just ran (via the plane's
        // walTimer, and any this service drove) may have healed foreign
        // checkpoints — persist the tally so health can surface it.
        await this.syncWalForeignCheckpoints(vaultId, shipper);
      } catch (err) {
        this.logger.warn(
          `backup: wal drain for ${vaultId} failed (will retry): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // ── Scheduler ─────────────────────────────────────────────────────────

  start(): void {
    if (this.timer) return;
    void this.syncEnabledPolicies().catch((err) => {
      this.logger.warn(
        `backup: provider policy sync failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.logger.warn(
          `backup: scheduler tick failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, HOUR_MS);
    this.timer.unref();
    this.walTimer = setInterval(() => {
      void this.drainWalDue().catch((err) => {
        this.logger.warn(
          `backup: wal drain tick failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, POLICY_SCHEDULER_TICK_MS);
    this.walTimer.unref();
  }

  /**
   * Clears the clocks, refuses new work, and waits for whatever
   * run is mid-flight on the chain — drains included, they run on the same
   * chain. A run that keeps writing shipper/backup state after the host
   * thinks it stopped would race vault-dir teardown (and, on a real
   * shutdown, the plane close that follows this call). Provider calls are
   * not cancellable, so correctness requires the plane to stay alive until
   * the serialized run actually finishes.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.walTimer) {
      clearInterval(this.walTimer);
      this.walTimer = undefined;
    }
    await this.chain.catch(() => undefined);
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    const backupConfigured = (await this.backend()) !== undefined;
    for (const plane of this.vaults.planesList()) {
      const vaultId = plane.boot.vaultId;
      const policy = readBackupPolicy(plane.db.vault);
      let state = await loadBackupState(this.backupDir);
      let target = state.targets[vaultId];
      if (target?.fenced) continue;
      // Keep the plane's blob sweep pinned to the retained-snapshot GC roots
      // (issue #436 §6) for every backup-configured vault — covers planes
      // mounted lazily after start, before their first scheduled backup.
      if (backupConfigured && target) this.attachSnapshotRoots(plane);
      if (backupConfigured) {
        const backupDue =
          !target?.lastBackupAt ||
          this.now() - Date.parse(target.lastBackupAt) >= policy.snapshotIntervalHours * HOUR_MS;
        if (backupDue) {
          await this.runBackup(vaultId);
          state = await loadBackupState(this.backupDir);
          target = state.targets[vaultId];
        }
        const verifyDue =
          target?.lastSeq !== undefined &&
          (!target.lastVerifiedAt ||
            this.now() - Date.parse(target.lastVerifiedAt) >= policy.verifyEveryDays * DAY_MS);
        if (verifyDue) {
          await this.runVerify(vaultId).catch((err) => {
            this.logger.warn(
              `backup: scheduled verify failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
        // Issue #408 G9: a real restore-verification on its own (weekly)
        // clock, baselined at first backup so fresh targets get grace.
        const restoreBaseline =
          target?.lastRestoreVerifiedAt ?? target?.firstBackupAt ?? target?.lastBackupAt;
        const restoreVerifyDue =
          target?.lastSeq !== undefined &&
          restoreBaseline !== undefined &&
          this.now() - Date.parse(restoreBaseline) >= policy.verifyEveryDays * DAY_MS;
        if (restoreVerifyDue) {
          await this.runRestoreVerify(vaultId).catch((err) => {
            this.logger.warn(
              `backup: scheduled restore-verify failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
      }
      state = await loadBackupState(this.backupDir);
      target = state.targets[vaultId];
      const remoteCas = readBlobStoreSettings(plane.db.vault).kind === 's3';
      const latestReconciliation =
        backupConfigured && target
          ? target.reconciliation
          : newestReconciliation(target?.reconciliation, state.casReconciliations[vaultId]);
      const reconciliationDue =
        ((backupConfigured && target !== undefined) || remoteCas) &&
        (latestReconciliation?.status === 'error' ||
          !latestReconciliation?.checkedAt ||
          this.now() - Date.parse(latestReconciliation.checkedAt) >=
            policy.verifyEveryDays * DAY_MS);
      if (reconciliationDue) await this.runReconciliation(vaultId);
    }
  }

  // ── CLI-facing reads ─────────────────────────────────────────────────

  async status(): Promise<Record<string, BackupTargetState>> {
    const state = await loadBackupState(this.backupDir);
    return state.targets;
  }

  /** Latest persisted remote-CAS inventory for vaults without a backup target. */
  async casReconciliationStatus(): Promise<Record<string, BackupReconciliationState>> {
    const state = await loadBackupState(this.backupDir);
    return state.casReconciliations;
  }

  /**
   * Recovery-kit confirmation gate (issue #351 wave 4 / #367): whether the
   * operator has ever acknowledged exporting + safely storing the
   * recovery kit. Generic on purpose — issue #367 reuses this same flag
   * to gate the S3-storage enable flow, so it isn't backup-card-specific.
   */
  async recoveryKitStatus(): Promise<RecoveryKitState> {
    if (this.recoveryKit) return this.recoveryKit.status();
    const state = await loadBackupState(this.backupDir);
    return state.recoveryKit;
  }

  /** Set the recovery-kit confirmation to now (epoch seconds). One-way —
   *  confirming again just refreshes the timestamp. */
  async confirmRecoveryKit(): Promise<RecoveryKitState> {
    if (this.recoveryKit) return this.recoveryKit.confirm();
    const state = await loadBackupState(this.backupDir);
    const recoveryKit: RecoveryKitState = { confirmedAt: Math.floor(this.now() / 1000) };
    state.recoveryKit = recoveryKit;
    await saveBackupState(this.backupDir, state);
    return recoveryKit;
  }

  async listSnapshots(vaultId: string, opts?: { includePruned?: boolean }): Promise<SnapshotRow[]> {
    const backend = await this.backend();
    if (!backend) throw new Error('backup is not configured — add a provider backup connection');
    const target = await this.requireTarget(vaultId);
    this.assertTargetBackend(target, backend);
    return backend.provider.listSnapshots(target.targetId, opts);
  }

  async restore(opts: {
    vaultId: string;
    destDir: string;
    seq?: number;
    /** Point-in-time restore (issue #408): replay WAL segments only up to this instant. */
    pointInTimeMs?: number;
    /**
     * Force a FULL restore even when the vault has a durable remote CAS tier
     * (issue #439 R2) — materialize every blob byte the snapshot carries. This
     * is the `--full` flag / operator-forensics override; it is IGNORED when an
     * explicit `lazy` option is supplied (that caller already resolved its own
     * tier). Absent ⇒ lazy-by-default: a vault with a durable remote tier
     * restores previews-first, deferring every remote-held blob.
     */
    full?: boolean;
    /**
     * Previews-first, lazy/partial restore (issue #405 §5). Present ⇒ every
     * blob the given remote CAS already holds is DEFERRED (never materialized
     * locally — the vault's custody read-through serves it on demand), so a
     * library far larger than the local disk restores onto a small gateway;
     * blobs the remote does NOT hold are still materialized (the snapshot is
     * their only copy). After the DB is up, a warm pass pulls ALL `thumb`
     * tinies into the local spool so the grid is usable in minutes. Absent ⇒
     * lazy is still resolved AUTOMATICALLY from the vault's own remote tier
     * (issue #439 R2) unless `full` is set — see the resolution note below.
     */
    lazy?: LazyRestoreOption;
  }): Promise<LazyRestoreResult> {
    const backend = await this.backend();
    if (!backend) throw new Error('backup is not configured — add a provider backup connection');
    const target = await this.requireTarget(opts.vaultId);
    this.assertTargetBackend(target, backend);
    const keyring = await this.ensureKeyring();
    // Issue #439 R2 — lazy is the DEFAULT, full is the flag. Resolution order:
    // an explicit `lazy` option (tests, the recovery UI once it holds its own
    // tier) wins; else a `--full` caller forces the bulk download; else
    // auto-resolve the vault's own durable remote CAS tier and prefer lazy
    // whenever one exists — the metered-egress whole-library download the CLI
    // used to always incur is exactly what the previews-first path was built to
    // avoid. No remote tier ⇒ the snapshot is the only copy ⇒ full.
    const lazy = opts.lazy ?? (opts.full ? undefined : this.autoLazyTier(opts.vaultId));
    const result = await restoreSnapshot({
      provider: backend.provider,
      targetId: target.targetId,
      keyring,
      vaultId: opts.vaultId,
      ...(opts.seq !== undefined ? { seq: opts.seq } : {}),
      ...(opts.pointInTimeMs !== undefined ? { pointInTimeMs: opts.pointInTimeMs } : {}),
      destDir: opts.destDir,
      // Lazy mode: defer any blob the remote CAS already holds — a live
      // `has(sha)` against the remote is the durability evidence a snapshot's
      // registry row still cannot carry (see backup-sources.ts). A blob the
      // remote lacks is NOT skipped: the snapshot is its only copy.
      ...(lazy ? { skipBlob: ({ sha }) => lazy.remote.store.has(sha) } : {}),
      log: { info: (m) => this.logger.info(m), warn: (m) => this.logger.warn(m) },
      current: {
        gatewayVersion: GATEWAY_VERSION,
        // The running code's ceiling — a fresh restore has no live plane to
        // read a PRAGMA off, so "current" is what THIS build understands.
        vaultUserVersion: String(VAULT_MIGRATIONS.length),
        ontologyVersion: ONTOLOGY_VERSION,
      },
    });
    // Exactly once, after the base + selected WAL prefix are materialized
    // and before the restored directory can be adopted or lazy-warmed.
    invalidateRestoredReplica(opts.destDir);
    if (!lazy) return result;
    // The DB is restored and WAL-replayed; the grid is only USABLE once its
    // tinies are local. Measure new-device time-to-usable-grid from here.
    const restoreCompleteMs = this.now();
    const previewsWarm = await warmPreviewTinies({
      destDir: opts.destDir,
      remote: lazy.remote,
      startedAtMs: restoreCompleteMs,
      now: () => this.now(),
      ...(lazy.warmConcurrency !== undefined ? { concurrency: lazy.warmConcurrency } : {}),
      log: { info: (m) => this.logger.info(m), warn: (m) => this.logger.warn(m) },
    });
    return { ...result, previewsWarm };
  }

  /**
   * The lazy-by-default skip-oracle + warm-pass source (issue #439 R2): the
   * vault's OWN settings-declared remote CAS tier, resolved through the live
   * plane's cached closure so the gateway never rebuilds S3 config. `undefined`
   * (⇒ full restore) when the vault isn't mounted or has no durable remote tier
   * — mirrors the `remoteTier()` null contract in `openVaultDb`.
   */
  private autoLazyTier(vaultId: string): LazyRestoreOption | undefined {
    const remote = this.vaults.get(vaultId)?.db.remote() ?? null;
    return remote ? { remote } : undefined;
  }

  /**
   * The metered-egress confirm gate's evidence (issue #439 R2), computed BEFORE
   * a restore starts and WITHOUT downloading a manifest. Small and reusable on
   * purpose: the CLI's gate calls it today, and the recovery UI's price card
   * (#436 §5) calls the same method later. See `RestoreEgressEstimate` for what
   * each field means and why the lazy figure is deliberately not fabricated.
   */
  async restoreEgressEstimate(opts: {
    vaultId: string;
    seq?: number;
    pointInTimeMs?: number;
  }): Promise<RestoreEgressEstimate> {
    const discovery = await this.homeDiscovery();
    const lazyAvailable = this.autoLazyTier(opts.vaultId) !== undefined;
    let row: SnapshotRow | undefined;
    try {
      const rows = await this.listSnapshots(opts.vaultId);
      row = pickSnapshotRow(rows, opts);
    } catch {
      // No target/snapshot yet, or the provider is unreachable: report an honest
      // "size unknown" (undefined) rather than block the gate on a byte count.
      row = undefined;
    }
    return {
      costClass: discovery?.restoreCostClass,
      seq: row?.seq,
      fullBytes: row?.totalBytes,
      lazyAvailable,
    };
  }

  async writeKit(destFile: string): Promise<void> {
    const backend = await this.backend();
    if (!backend) throw new Error('backup is not configured — add a provider backup connection');
    const keyring = await this.ensureKeyring();
    const state = await loadBackupState(this.backupDir);
    await writeBackupRecoveryKit({ keyring, state, provider: backend.label, destFile });
  }

  /** Recovery-kit document for owner-facing HTTP export. Contains live key material. */
  async recoveryKitDocument(): Promise<Record<string, unknown>> {
    const backend = await this.backend();
    if (!backend) throw new Error('backup is not configured — add a provider backup connection');
    const keyring = await this.ensureKeyring();
    const state = await loadBackupState(this.backupDir);
    return recoveryKitDocument({ keyring, state, provider: backend.label, now: this.now() });
  }

  private async requireTarget(vaultId: string): Promise<BackupTargetState> {
    const state = await loadBackupState(this.backupDir);
    const target = state.targets[vaultId];
    if (!target) throw new Error(`backup: vault "${vaultId}" has no backup target yet`);
    return target;
  }
}

export function createBackupService(opts: BackupServiceOptions): BackupService {
  return new BackupService(opts);
}

export type { BackupState, RecoveryKitState };
