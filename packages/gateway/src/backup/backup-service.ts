/*
 * `BackupService` — the gateway-side owner of the offsite backup engine
 * (`@centraid/backup`, PROTOCOL.md + FORMAT.md). Static CLI configuration
 * or the desktop's live provider connection resolves through one engine;
 * manual runs and the scheduler intentionally share the same code path.
 */

import path from 'node:path';
import {
  BackupProviderError,
  createKeyring,
  createSnapshot,
  loadKeyring,
  openLocalBackupProvider,
  openRemoteBackupProvider,
  restoreSnapshot,
  verifySnapshot,
  type BackupProvider,
  type Keyring,
  type RestoreResult,
  type SnapshotRow,
  type SourceEntry,
  type VerifySnapshotResult,
} from '@centraid/backup';
import { ONTOLOGY_VERSION, VAULT_MIGRATIONS } from '@centraid/vault';
import type { RuntimeLogger } from '@centraid/app-engine';
import {
  intervalHoursOf,
  verifyEveryDaysOf,
  DEFAULT_INTERVAL_HOURS,
  DEFAULT_VERIFY_EVERY_DAYS,
  type BackupConfig,
  type BackupProviderConfig,
} from './backup-config.js';
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

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function buildBackupProvider(config: BackupProviderConfig): BackupProvider {
  return config.kind === 'local'
    ? openLocalBackupProvider({ rootDir: config.dir })
    : openRemoteBackupProvider({ baseUrl: config.endpoint, apiKey: config.apiKey });
}

import { resolveBackupBackend } from './backup-backend.js';
import { evaluateBackupHealth } from './backup-health.js';
import { recoveryKitDocument, writeBackupRecoveryKit } from './backup-recovery-kit.js';

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
  /** Injectable provider (tests) — defaults to `buildBackupProvider(config.provider)`. */
  provider?: BackupProvider;
  storageConnections?: StorageConnectionStore;
  /** Shared confirmation store; CLI-only callers fall back to backup state. */
  recoveryKit?: RecoveryKitStateStore;
}

export class BackupService {
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
  private readonly recoveryKit: RecoveryKitStateStore | undefined;
  private keyring: Keyring | undefined;
  private timer: NodeJS.Timeout | undefined;
  /** Serializes every run — "one at a time (no concurrent backups)". */
  private chain: Promise<void> = Promise.resolve();
  /** The vault/kind currently executing inside `chain`, if any — read by
   *  `isRunning()` (the `_gateway/backup` route's `running` flag). */
  private activeRun: { vaultId: string; kind: 'backup' | 'verify' } | undefined;

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

  private async probe(): Promise<{ status: 'ok' | 'degraded' | 'error'; detail?: string }> {
    if (!(await this.backend())) return { status: 'ok', detail: 'backup is not configured' };
    return evaluateBackupHealth({
      state: await loadBackupState(this.backupDir),
      ...(this.config ? { config: this.config } : {}),
      now: this.now(),
    });
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

  /** Serialize `fn` after every run already queued. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // ── Backup ────────────────────────────────────────────────────────────

  async runBackup(vaultId: string): Promise<void> {
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
    if (!target) {
      const label = opaqueLabel();
      const { targetId } = await backend.provider.createTarget({ label });
      target = { targetId, label, generation: 1, providerRef: backend.providerRef };
      state.targets[vaultId] = target;
      await saveBackupState(this.backupDir, state);
    }

    const stagingDir = path.join(this.backupDir, 'staging', vaultId);
    await resetStagingDir(stagingDir);
    try {
      const entries = await this.assembleEntries({
        plane,
        stagingDir,
        log: { info: (m) => this.logger.info(m), warn: (m) => this.logger.warn(m) },
      });
      const row = await createSnapshot({
        provider: backend.provider,
        targetId: target.targetId,
        keyring,
        vaultId,
        entries,
        generation: target.generation,
        appMeta: this.appMetaFor(plane, state.sourceInstanceId),
        log: { info: (m) => this.logger.info(m), warn: (m) => this.logger.warn(m) },
      });
      target.lastBackupAt = new Date(this.now()).toISOString();
      if (row) target.lastSeq = row.seq;
      delete target.lastError;
      state.targets[vaultId] = target;
      await saveBackupState(this.backupDir, state);
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
    const keyring = await this.ensureKeyring();
    try {
      const result = await verifySnapshot({
        provider: backend.provider,
        targetId: target.targetId,
        keyring,
        vaultId,
      });
      target.lastVerifiedAt = new Date(this.now()).toISOString();
      state.targets[vaultId] = target;
      await saveBackupState(this.backupDir, state);
      if (result.missing.length > 0 || result.corrupt.length > 0) {
        this.health.reportError(
          'backups',
          `vault ${vaultId}: verify found ${result.missing.length} missing, ${result.corrupt.length} corrupt object(s)`,
        );
      } else {
        this.health.reportOk(
          'backups',
          `vault ${vaultId}: verify ok (${result.checkedObjects} checked, ${result.sampled} sampled)`,
        );
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.health.reportError('backups', `vault ${vaultId}: verify failed: ${message}`);
      throw err;
    }
  }

  // ── Scheduler ─────────────────────────────────────────────────────────

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.logger.warn(
          `backup: scheduler tick failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, HOUR_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<void> {
    if (!(await this.backend())) return;
    const intervalMs =
      (this.config ? intervalHoursOf(this.config) : DEFAULT_INTERVAL_HOURS) * HOUR_MS;
    const verifyMs =
      (this.config ? verifyEveryDaysOf(this.config) : DEFAULT_VERIFY_EVERY_DAYS) * DAY_MS;
    for (const plane of this.vaults.planesList()) {
      const vaultId = plane.boot.vaultId;
      let state = await loadBackupState(this.backupDir);
      let target = state.targets[vaultId];
      if (target?.fenced) continue;
      const backupDue =
        !target?.lastBackupAt || this.now() - Date.parse(target.lastBackupAt) >= intervalMs;
      if (backupDue) {
        await this.runBackup(vaultId);
        state = await loadBackupState(this.backupDir);
        target = state.targets[vaultId];
      }
      const verifyDue =
        target?.lastSeq !== undefined &&
        (!target.lastVerifiedAt || this.now() - Date.parse(target.lastVerifiedAt) >= verifyMs);
      if (verifyDue) await this.runVerify(vaultId);
    }
  }

  // ── CLI-facing reads ─────────────────────────────────────────────────

  async status(): Promise<Record<string, BackupTargetState>> {
    const state = await loadBackupState(this.backupDir);
    return state.targets;
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
    return backend.provider.listSnapshots(target.targetId, opts);
  }

  async restore(opts: { vaultId: string; destDir: string; seq?: number }): Promise<RestoreResult> {
    const backend = await this.backend();
    if (!backend) throw new Error('backup is not configured — add a provider backup connection');
    const target = await this.requireTarget(opts.vaultId);
    const keyring = await this.ensureKeyring();
    return restoreSnapshot({
      provider: backend.provider,
      targetId: target.targetId,
      keyring,
      vaultId: opts.vaultId,
      ...(opts.seq !== undefined ? { seq: opts.seq } : {}),
      destDir: opts.destDir,
      current: {
        gatewayVersion: GATEWAY_VERSION,
        // The running code's ceiling — a fresh restore has no live plane to
        // read a PRAGMA off, so "current" is what THIS build understands.
        vaultUserVersion: String(VAULT_MIGRATIONS.length),
        ontologyVersion: ONTOLOGY_VERSION,
      },
    });
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
