/*
 * Per-gateway backup state (`<backupDir>/state.json`): one row per vault
 * this gateway has ever backed up, plus a `sourceInstanceId` — the random
 * id every snapshot's `appMeta.sourceInstanceId` carries (FORMAT.md
 * manifest §, "random id minted per gateway install") so a restoring
 * client can tell which physical install wrote a given snapshot.
 *
 * Atomic writes (temp + rename), like `local-provider.ts`'s registry and
 * `crypto.ts`'s keyring — a crash mid-write must never leave a torn file
 * the next boot reads as truth.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface BackupTargetState {
  targetId: string;
  /** Stable destination identity; prevents silently writing an existing vault target through a newly-selected provider. */
  providerRef?: string;
  /** The opaque random label the target was created with (never the vault name). */
  label: string;
  /** Fencing generation (PROTOCOL.md § Generation fencing) — starts at 1. */
  generation: number;
  /** Immutable baseline for first scheduled restore-verification. */
  firstBackupAt?: string;
  lastBackupAt?: string;
  lastVerifiedAt?: string;
  lastSeq?: number;
  /**
   * Set once a `conflict_generation` response is seen (PROTOCOL.md: "never
   * retry with a bumped generation automatically"). While fenced, the
   * scheduler skips this vault; a manual `backup run` still attempts (and
   * will 409 again) so the operator sees the same loud signal on demand.
   */
  fenced?: boolean;
  lastError?: string;
  /** Last snapshot-object verification failure; cleared only by a clean verify. */
  lastVerifyError?: string;
  /** Last SUCCESSFUL restore-verification (issue #408 G9) — a real restore
   *  from the remote into a scratch dir that passed every check. */
  lastRestoreVerifiedAt?: string;
  /**
   * Why the last restore-verification FAILED (issue #408 G9), cleared on the
   * next success. Persisted so the health PROBE (which recomputes from this
   * state at snapshot time and overrides pushed reports — see
   * `HealthRegistry.registerProbe`) stays red on real damage instead of
   * reverting to green until the 14-day staleness alarm.
   */
  lastRestoreVerifyError?: string;
  /**
   * How many journal receipts the last restore-verification found naming a
   * vault row absent from the restored vault (issue #408 G8). Not a failed
   * restore — hard-deletes explain it (see `verifyRestoredPair`) — so it is a
   * DEGRADED signal for human review, and persisted for the same reason
   * `lastRestoreVerifyError` is: the health probe recomputes from this state
   * and overrides pushed reports, so a degrade that lived only in a pushed
   * report would be repainted green by the very next probe. Cleared (deleted)
   * by the next restore-verification that finds none.
   */
  lastRestoreVerifyDangling?: number;
  /**
   * WAL generation → the keyring epoch it seals under (issue #408): restore
   * derives segment keys from the MANIFEST's `keyEpoch`, so each generation
   * must seal under exactly one epoch for its whole life. Recorded at first
   * drain/registration; rotation forces fresh generations (see
   * BackupService), and pruned generations fall out of the map.
   */
  walGenerationEpochs?: Record<string, number>;
  /**
   * `"{vaultGeneration}-{journalGeneration}"` → the newest pair-marker tick the
   * provider has CONFIRMED accepting for that base pair (issue #408).
   *
   * Only `drainWalFiles` writes it, and only after a PUT returns — never from
   * local intent. That provenance is the whole point: the value is stamped into
   * the next manifest as `walTipTickMs`, where it becomes a floor the store is
   * held to, so a drain interrupted between a tick's segments and its marker
   * must yield a LOWER tip rather than a claim the store cannot honour.
   * Generation breaks mint a new pair key (so the tip resets naturally), and
   * pruned generations fall out of the map.
   */
  walMarkerTips?: Record<string, number>;
  /**
   * Issue #411 action 1: how many FOREIGN checkpoints the vault's WAL shipper
   * has detected and healed — something other than the shipper checkpointed one
   * of the databases, forcing a generation break (base re-clone). Copied from
   * `WalShipper.status().foreignCheckpointCount` whenever it advances. Persisted
   * — exactly like `lastRestoreVerify*` above — because the health PROBE
   * recomputes from this state and overrides pushed reports (see
   * `HealthRegistry.registerProbe`): a degrade that lived only in a pushed
   * report would be repainted green by the very next probe. Monotone; a
   * perf/churn signal, never a correctness failure (verification already
   * re-based). `evaluateBackupHealth` ages it out on the last occurrence.
   */
  walForeignCheckpointCount?: number;
  /** The most recent foreign checkpoint the shipper detected: when (epoch ms),
   *  which database, and the break reason. Drives the degraded window in
   *  `evaluateBackupHealth`. `db` is a plain string (the vault's `WalDbName`)
   *  to avoid a cross-package type dependency, matching `walGenerationEpochs`. */
  walLastForeignCheckpoint?: { atMs: number; db: string; reason: string };
}

/**
 * Recovery-kit confirmation gate (issue #351 wave 4 / #367): a generic
 * "the operator has confirmed they hold the recovery kit" flag, NOT
 * scoped to the backup card that first surfaces it — issue #367 will
 * reuse this exact field to gate the S3-storage enable flow, so it stays
 * a plain acknowledgement rather than anything backup-specific.
 */
export interface RecoveryKitState {
  /** Epoch SECONDS the operator last confirmed, or `null` if never. */
  confirmedAt: number | null;
}

export interface BackupState {
  targets: Record<string, BackupTargetState>;
  /** Random id minted once per gateway install (FORMAT.md `appMeta.sourceInstanceId`). */
  sourceInstanceId: string;
  recoveryKit: RecoveryKitState;
}

function emptyState(): BackupState {
  return {
    targets: {},
    sourceInstanceId: randomBytes(16).toString('hex'),
    recoveryKit: { confirmedAt: null },
  };
}

export function stateFile(backupDir: string): string {
  return path.join(backupDir, 'state.json');
}

export async function loadBackupState(backupDir: string): Promise<BackupState> {
  try {
    const raw = await fs.readFile(stateFile(backupDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<BackupState>;
    return {
      targets: parsed.targets ?? {},
      sourceInstanceId: parsed.sourceInstanceId ?? randomBytes(16).toString('hex'),
      // Absent on a state.json written before this wave — defaults to
      // "never confirmed" rather than assuming a pre-existing install
      // already handled its recovery kit.
      recoveryKit: parsed.recoveryKit ?? { confirmedAt: null },
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return emptyState();
  }
}

export async function saveBackupState(backupDir: string, state: BackupState): Promise<void> {
  await fs.mkdir(backupDir, { recursive: true });
  const file = stateFile(backupDir);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}

/** A random, opaque target label — PROTOCOL.md: "Clients MUST NOT send real vault names". */
export function opaqueLabel(): string {
  return randomBytes(8).toString('hex');
}
