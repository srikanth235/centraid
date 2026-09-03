import { createHmac, randomBytes } from "node:crypto";

import { GatewayDatabase } from "../serve/gateway-db.js";
import type { ProviderPolicySyncState } from "./backup-provider-observability.js";
import type { BackupReconciliationState } from "./backup-reconciliation.js";

export interface BackupTargetState {
  targetId: string;
  providerRef?: string;
  label: string;
  generation: number;
  firstBackupAt?: string;
  lastBackupAt?: string;
  lastVerifiedAt?: string;
  lastWalDrainAt?: string;
  providerPolicy?: ProviderPolicySyncState;
  reconciliation?: BackupReconciliationState;
  lastSeq?: number;
  fenced?: boolean;
  lastError?: string;
  lastVerifyError?: string;
  lastRestoreVerifiedAt?: string;
  lastRestoreVerifyError?: string;
  lastRestoreVerifyDangling?: number;
  walGenerationEpochs?: Record<string, number>;
  walMarkerTips?: Record<string, number>;
  walForeignCheckpointCount?: number;
  walLastForeignCheckpoint?: { atMs: number; reason: string };
}

export interface BackupState {
  targets: Record<string, BackupTargetState>;
  casReconciliations: Record<string, BackupReconciliationState>;
  sourceInstanceId: string;
}

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

export function opaqueLabel(): string {
  return randomBytes(8).toString("hex");
}
