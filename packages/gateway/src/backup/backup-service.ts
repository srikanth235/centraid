/*
 * `BackupService` — the gateway-side owner of the offsite backup engine
 * (`@centraid/backup`, PROTOCOL.md + FORMAT.md). One instance per gateway,
 * constructed only when `backup.enabled` — it holds the provider handle,
 * the keyring, the per-vault state file, and the hourly scheduler; `runBackup`
 * / `runVerify` are also the CLI's entry points (`cli/backup-admin.ts`),
 * so a manual `backup run` and the scheduler share one code path.
 *
 * Health (mirrors the outbox pattern in `build-gateway.ts`): PUSH —
 * `reportOk`/`reportError` around every run; PULL — a probe flags
 * `lastBackupAt` older than 2x `intervalHours` as `error` ("backups are
 * stale") and `lastVerifiedAt` older than 2x `verifyEveryDays` as
 * `degraded`. Registered ONLY when backup is enabled.
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
  writeRecoveryKit,
  type BackupProvider,
  type Keyring,
  type RecoveryKitTarget,
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
  type BackupConfig,
  type BackupProviderConfig,
} from './backup-config.js';
import {
  loadBackupState,
  opaqueLabel,
  saveBackupState,
  type BackupState,
  type BackupTargetState,
} from './backup-state.js';
import { assembleSourceEntries, resetStagingDir, type AssembleOptions } from './backup-sources.js';
import type { HealthRegistry } from '../serve/health-registry.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import type { VaultPlane } from '../serve/vault-plane.js';
import { GATEWAY_VERSION } from '../version.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function buildBackupProvider(config: BackupProviderConfig): BackupProvider {
  return config.kind === 'local'
    ? openLocalBackupProvider({ rootDir: config.dir })
    : openRemoteBackupProvider({ baseUrl: config.endpoint, apiKey: config.apiKey });
}

/** Human-readable provider label for the recovery kit (FORMAT.md's `targets[].provider`). */
function providerLabel(config: BackupProviderConfig): string {
  return config.kind === 'remote' ? config.endpoint : `local:${config.dir}`;
}

export interface BackupServiceOptions {
  config: BackupConfig;
  /** `<dataDir>/backup` — holds `keyring.json`, `state.json`, `staging/`. */
  backupDir: string;
  vaults: VaultRegistry;
  health: HealthRegistry;
  logger: RuntimeLogger;
  /** Clock override (tests). */
  now?: () => number;
  /**
   * Injectable seam over `assembleSourceEntries` (tests). Defaults to the
   * real one, which stages fresh VACUUM INTO DB copies every run — a real
   * vault's `journal.db` therefore never hashes byte-identical twice in a
   * row (staging itself receipts into the ledger, FORMAT.md's ordering
   * rule notwithstanding), so exercising "no visible change → no new
   * manifest" needs static fixture files a test controls directly instead.
   */
  assembleEntries?: (opts: AssembleOptions) => Promise<SourceEntry[]>;
  /** Injectable provider (tests) — defaults to `buildBackupProvider(config.provider)`. */
  provider?: BackupProvider;
}

export class BackupService {
  private readonly config: BackupConfig;
  private readonly backupDir: string;
  private readonly vaults: VaultRegistry;
  private readonly health: HealthRegistry;
  private readonly logger: RuntimeLogger;
  private readonly now: () => number;
  private readonly provider: BackupProvider;
  private readonly keyringPath: string;
  private readonly assembleEntries: (opts: AssembleOptions) => Promise<SourceEntry[]>;
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
    this.provider = opts.provider ?? buildBackupProvider(this.config.provider);
    this.keyringPath = this.config.keyringPath ?? path.join(this.backupDir, 'keyring.json');
    this.assembleEntries = opts.assembleEntries ?? assembleSourceEntries;

    this.health.registerProbe('backups', async () => this.probe());
  }

  private async probe(): Promise<{ status: 'ok' | 'degraded' | 'error'; detail?: string }> {
    const state = await loadBackupState(this.backupDir);
    const rows = Object.entries(state.targets);
    if (rows.length === 0) return { status: 'ok', detail: 'no vaults backed up yet' };
    const staleBackupMs = intervalHoursOf(this.config) * HOUR_MS * 2;
    const staleVerifyMs = verifyEveryDaysOf(this.config) * DAY_MS * 2;
    let worst: 'ok' | 'degraded' | 'error' = 'ok';
    const notes: string[] = [];
    for (const [vaultId, target] of rows) {
      if (target.fenced) {
        worst = 'error';
        notes.push(`${vaultId}: fenced — another machine has taken over this vault`);
        continue;
      }
      const backupAgeMs = target.lastBackupAt
        ? this.now() - Date.parse(target.lastBackupAt)
        : Number.POSITIVE_INFINITY;
      if (backupAgeMs >= staleBackupMs) {
        worst = 'error';
        notes.push(`${vaultId}: backups are stale`);
        continue;
      }
      // Never-verified targets start their staleness clock at the first
      // backup, not at "the dawn of time" — a target one tick old hasn't
      // had a chance to verify yet and shouldn't read as degraded.
      const verifyBaseline = target.lastVerifiedAt ?? target.lastBackupAt;
      const verifyAgeMs = verifyBaseline
        ? this.now() - Date.parse(verifyBaseline)
        : Number.POSITIVE_INFINITY;
      if (verifyAgeMs >= staleVerifyMs) {
        if (worst !== 'error') worst = 'degraded';
        notes.push(`${vaultId}: verification is stale`);
      }
    }
    return {
      status: worst,
      detail: notes.length > 0 ? notes.join('; ') : `${rows.length} vault(s) backed up`,
    };
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
    const keyring = await this.ensureKeyring();
    if (!target) {
      const label = opaqueLabel();
      const { targetId } = await this.provider.createTarget({ label });
      target = { targetId, label, generation: 1 };
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
        provider: this.provider,
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

  private async doRunVerify(vaultId: string): Promise<VerifySnapshotResult | undefined> {
    const state = await loadBackupState(this.backupDir);
    const target = state.targets[vaultId];
    if (!target) {
      this.logger.warn(`backup verify: vault ${vaultId} has no backup target yet — skipped`);
      return undefined;
    }
    const keyring = await this.ensureKeyring();
    try {
      const result = await verifySnapshot({
        provider: this.provider,
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
    const intervalMs = intervalHoursOf(this.config) * HOUR_MS;
    const verifyMs = verifyEveryDaysOf(this.config) * DAY_MS;
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

  async listSnapshots(vaultId: string, opts?: { includePruned?: boolean }): Promise<SnapshotRow[]> {
    const target = await this.requireTarget(vaultId);
    return this.provider.listSnapshots(target.targetId, opts);
  }

  async restore(opts: { vaultId: string; destDir: string; seq?: number }): Promise<RestoreResult> {
    const target = await this.requireTarget(opts.vaultId);
    const keyring = await this.ensureKeyring();
    return restoreSnapshot({
      provider: this.provider,
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
    const keyring = await this.ensureKeyring();
    const state = await loadBackupState(this.backupDir);
    const targets: RecoveryKitTarget[] = Object.entries(state.targets).map(([vaultId, t]) => ({
      provider: providerLabel(this.config.provider),
      targetId: t.targetId,
      vaultId,
      label: t.label,
    }));
    await writeRecoveryKit({ keyring, targets, destFile });
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

export type { BackupState };
