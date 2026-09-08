// Gateway backup target/fencing state in gateway.db (#555). Degrade fields are
// PERSISTED because the health probe recomputes from this state and overrides
// pushed reports, which would otherwise repaint a degrade green.

import { createHmac, randomBytes } from "node:crypto";

import { GatewayDatabase } from "../serve/gateway-db.js";
import type { ProviderPolicySyncState } from "./backup-provider-observability.js";
import type { BackupReconciliationState } from "./backup-reconciliation.js";

export interface BackupTargetState {
  targetId: string;
  providerRef?: string;
  /** Never the vault name. */
  label: string;
  /** PROTOCOL.md § Generation fencing; starts at 1. */
  generation: number;
  firstBackupAt?: string;
  lastBackupAt?: string;
  lastVerifiedAt?: string;
  lastWalDrainAt?: string;
  providerPolicy?: ProviderPolicySyncState;
  reconciliation?: BackupReconciliationState;
  lastSeq?: number;
  /** PROTOCOL.md: never bump a generation automatically. A manual run still
   *  409s, so the operator sees it on demand. */
  fenced?: boolean;
  lastError?: string;
  lastVerifyError?: string;
  lastRestoreVerifiedAt?: string;
  lastRestoreVerifyError?: string;
  /** Hard-deletes explain these: DEGRADED, not a failure. */
  lastRestoreVerifyDangling?: number;
  /** Restore derives segment keys from the manifest, so a generation seals
   *  under exactly one epoch for life (#408). */
  walGenerationEpochs?: Record<string, number>;
  /** Written only after a PUT returns, never from local intent: it becomes the
   *  next manifest's `walTipTickMs` floor, so an interrupted drain must yield a
   *  LOWER tip. */
  walMarkerTips?: Record<string, number>;
  /** A foreign checkpoint forces a generation break (#411). A churn signal,
   *  never a correctness failure. */
  walForeignCheckpointCount?: number;
  walLastForeignCheckpoint?: { atMs: number; reason: string };
}

export interface BackupState {
  targets: Record<string, BackupTargetState>;
  casReconciliations: Record<string, BackupReconciliationState>;
  sourceInstanceId: string;
}

/** Derived from gateway custody, never persisted. */
export function deriveBackupSourceInstanceId(endpointSecret: Buffer): string {
  return createHmac("sha256", endpointSecret)
    .update("backup-source", "utf8")
    .digest("hex");
}

export async function loadBackupState(
  source: string | GatewayDatabase,
  sourceInstanceId?: string
): Promise<BackupState> {
  if (source instanceof GatewayDatabase) {
    const targets = Object.fromEntries(
      (
        source.db
          .prepare(
            "SELECT vault_id, config_json FROM backup_targets ORDER BY vault_id"
          )
          .all() as Array<{ vault_id: string; config_json: string }>
      ).map((row) => [
        row.vault_id,
        JSON.parse(row.config_json) as BackupTargetState,
      ])
    );
    const casReconciliations = Object.fromEntries(
      (
        source.db
          .prepare(
            "SELECT vault_id, state_json FROM cas_reconciliations ORDER BY vault_id"
          )
          .all() as Array<{ vault_id: string; state_json: string }>
      ).map((row) => [
        row.vault_id,
        JSON.parse(row.state_json) as BackupReconciliationState,
      ])
    );
    return {
      targets,
      casReconciliations,
      sourceInstanceId: sourceInstanceId ?? randomBytes(16).toString("hex"),
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
  state: BackupState
): Promise<void> {
  if (source instanceof GatewayDatabase) {
    source.transaction(() => {
      source.db.exec(
        "DELETE FROM backup_targets; DELETE FROM cas_reconciliations;"
      );
      const targetInsert = source.db.prepare(
        `INSERT INTO backup_targets (target_id, vault_id, config_json, updated_at)
         VALUES (?, ?, ?, ?)`
      );
      for (const [vaultId, target] of Object.entries(state.targets)) {
        targetInsert.run(
          target.targetId,
          vaultId,
          JSON.stringify(target),
          new Date().toISOString()
        );
      }
      const reconciliationInsert = source.db.prepare(
        `INSERT INTO cas_reconciliations (vault_id, state_json, updated_at)
         VALUES (?, ?, ?)`
      );
      for (const [vaultId, reconciliation] of Object.entries(
        state.casReconciliations
      )) {
        reconciliationInsert.run(
          vaultId,
          JSON.stringify(reconciliation),
          new Date().toISOString()
        );
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

/** PROTOCOL.md: "Clients MUST NOT send real vault names". */
export function opaqueLabel(): string {
  return randomBytes(8).toString("hex");
}
