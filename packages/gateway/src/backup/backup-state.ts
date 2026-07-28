/* Gateway backup target/fencing state in gateway.db (issue #555). */

import { createHmac, randomBytes } from 'node:crypto';

import { GatewayDatabase } from '../serve/gateway-db.js';
import type { ProviderPolicySyncState } from './backup-provider-observability.js';
import type { BackupReconciliationState } from './backup-reconciliation.js';

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
  /** Last successful offsite WAL drain attempt for the live status surface. */
  lastWalDrainAt?: string;
  /** Desired policy + provider echo/rejection, persisted so health cannot repaint drift green. */
  providerPolicy?: ProviderPolicySyncState;
  /** Last non-destructive provider/bucket inventory audit. */
  reconciliation?: BackupReconciliationState;
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

export interface BackupState {
  targets: Record<string, BackupTargetState>;
  /** Latest CAS inventory for vaults that have remote primary storage but no backup target. */
  casReconciliations: Record<string, BackupReconciliationState>;
  /** HMAC-derived from the endpoint secret; never persisted independently. */
  sourceInstanceId: string;
}

/** Stable private backup-writer identity derived from gateway custody, never persisted. */
export function deriveBackupSourceInstanceId(endpointSecret: Buffer): string {
  return createHmac('sha256', endpointSecret).update('backup-source', 'utf8').digest('hex');
}

export async function loadBackupState(
  source: string | GatewayDatabase,
  sourceInstanceId?: string,
): Promise<BackupState> {
  if (source instanceof GatewayDatabase) {
    const targets = Object.fromEntries(
      (
        source.db
          .prepare('SELECT vault_id, config_json FROM backup_targets ORDER BY vault_id')
          .all() as Array<{ vault_id: string; config_json: string }>
      ).map((row) => [row.vault_id, JSON.parse(row.config_json) as BackupTargetState]),
    );
    const casReconciliations = Object.fromEntries(
      (
        source.db
          .prepare('SELECT vault_id, state_json FROM cas_reconciliations ORDER BY vault_id')
          .all() as Array<{ vault_id: string; state_json: string }>
      ).map((row) => [row.vault_id, JSON.parse(row.state_json) as BackupReconciliationState]),
    );
    return {
      targets,
      casReconciliations,
      sourceInstanceId: sourceInstanceId ?? randomBytes(16).toString('hex'),
    };
  }
  const database = GatewayDatabase.open(source);
  try {
    return await loadBackupState(database, sourceInstanceId);
  } finally {
    database.close();
  }
}

export async function saveBackupState(
  source: string | GatewayDatabase,
  state: BackupState,
): Promise<void> {
  if (source instanceof GatewayDatabase) {
    source.transaction(() => {
      source.db.exec('DELETE FROM backup_targets; DELETE FROM cas_reconciliations;');
      const targetInsert = source.db.prepare(
        `INSERT INTO backup_targets (target_id, vault_id, config_json, updated_at)
         VALUES (?, ?, ?, ?)`,
      );
      for (const [vaultId, target] of Object.entries(state.targets)) {
        targetInsert.run(
          target.targetId,
          vaultId,
          JSON.stringify(target),
          new Date().toISOString(),
        );
      }
      const reconciliationInsert = source.db.prepare(
        `INSERT INTO cas_reconciliations (vault_id, state_json, updated_at)
         VALUES (?, ?, ?)`,
      );
      for (const [vaultId, reconciliation] of Object.entries(state.casReconciliations)) {
        reconciliationInsert.run(vaultId, JSON.stringify(reconciliation), new Date().toISOString());
      }
    });
    return;
  }
  const database = GatewayDatabase.open(source);
  try {
    await saveBackupState(database, state);
  } finally {
    database.close();
  }
}

/** A random, opaque target label — PROTOCOL.md: "Clients MUST NOT send real vault names". */
export function opaqueLabel(): string {
  return randomBytes(8).toString('hex');
}
