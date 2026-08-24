/*
 * Durable vault erase completion (#555).
 *
 * Gateway rows are removed and an erase_intents row is committed before any
 * filesystem unlink. A process death can therefore leave only one recoverable
 * intermediate state: "rows gone, intent present, bytes possibly present".
 * Boot completes every such intent before mounting the registry, so it can
 * never resurrect a half-erased vault or roll enrollment rows back around
 * already-deleted files.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

import type { RuntimeLogger } from "@centraid/server/engine";
import type { KeyStore } from "@centraid/vault";

import type { GatewayDatabase } from "./gateway-db.js";

export interface PendingEraseRecoveryOptions {
  gatewayDatabase: GatewayDatabase;
  vaultRoot: string;
  cacheRoot: string;
  keys: KeyStore;
  logger: RuntimeLogger;
}

function removeIfEmpty(dir: string): void {
  if (existsSync(dir) && readdirSync(dir).length === 0) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Finish all state-first erases. Idempotent across repeated crashes. */
export function recoverPendingVaultErases(
  options: PendingEraseRecoveryOptions
): string[] {
  const rows = options.gatewayDatabase.db
    .prepare("SELECT vault_id FROM erase_intents ORDER BY created_at, vault_id")
    .all() as Array<{ vault_id: string }>;
  const completed: string[] = [];
  for (const { vault_id: vaultId } of rows) {
    rmSync(path.join(options.vaultRoot, vaultId), {
      recursive: true,
      force: true,
    });
    rmSync(path.join(options.cacheRoot, vaultId), {
      recursive: true,
      force: true,
    });
    options.keys.destroy(`${vaultId}.sealkey`);
    options.gatewayDatabase.transaction(() => {
      options.gatewayDatabase.db
        .prepare("DELETE FROM erase_intents WHERE vault_id = ?")
        .run(vaultId);
    });
    completed.push(vaultId);
    options.logger.info(
      `vault erase: completed durable erase intent for ${vaultId}`
    );
  }
  removeIfEmpty(options.vaultRoot);
  removeIfEmpty(options.cacheRoot);
  return completed;
}
