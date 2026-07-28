/*
 * Crash recovery for the zero→one founding boundary (issue #555).
 *
 * A reservation records every vault id before filesystem mutation. Successful
 * ticket consumption deletes that row in the same transaction that enrolls
 * the first owner. Therefore a surviving marker proves the local vault is
 * uncommitted and must be removed before the registry scans the filesystem.
 */

import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import type { RuntimeLogger } from '@centraid/app-engine';
import type { KeyStore } from '@centraid/vault';

import type { GatewayDatabase } from './gateway-db.js';
import { PairingTicketStore } from './pairing-store.js';

export interface PendingFoundingRecoveryOptions {
  gatewayDatabase: GatewayDatabase;
  vaultRoot: string;
  cacheRoot: string;
  keys: KeyStore;
  logger: RuntimeLogger;
}

function childPath(root: string, vaultId: string): string {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, vaultId);
  if (path.dirname(candidate) !== resolvedRoot) {
    throw new Error(`invalid pending founding vault id ${JSON.stringify(vaultId)}`);
  }
  return candidate;
}

function removeIfEmpty(dir: string): void {
  if (existsSync(dir) && readdirSync(dir).length === 0) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Idempotently roll back every founding filesystem mutation lacking an owner commit. */
export function recoverPendingFoundingVaults(options: PendingFoundingRecoveryOptions): string[] {
  const tickets = PairingTicketStore.open(options.gatewayDatabase);
  const pending = tickets.pendingFoundingVaults();
  const removed: string[] = [];
  for (const row of pending) {
    for (const vaultId of row.vaultIds) {
      const enrollment = options.gatewayDatabase.db
        // Authority lives on `member_roles` since #599: a granted role is the
        // proof that a founding ceremony committed an owner for this vault.
        .prepare('SELECT 1 AS present FROM member_roles WHERE vault_id = ? LIMIT 1')
        .get(vaultId) as { present: number } | undefined;
      if (enrollment) {
        throw new Error(
          `pending founding vault ${vaultId} already has an enrollment; refusing destructive recovery`,
        );
      }
      rmSync(childPath(options.vaultRoot, vaultId), {
        recursive: true,
        force: true,
      });
      rmSync(childPath(options.cacheRoot, vaultId), {
        recursive: true,
        force: true,
      });
      options.keys.destroy(`${vaultId}.sealkey`);
      options.gatewayDatabase.transaction(() => {
        options.gatewayDatabase.db
          .prepare('DELETE FROM backup_targets WHERE vault_id = ?')
          .run(vaultId);
        options.gatewayDatabase.db
          .prepare('DELETE FROM cas_reconciliations WHERE vault_id = ?')
          .run(vaultId);
      });
      removed.push(vaultId);
      options.logger.info(`vault founding: removed uncommitted local vault ${vaultId}`);
    }
    tickets.clearReservedFoundingVaults(row.reservationId, row.vaultIds);
  }

  if (pending.length > 0 && existsSync(options.vaultRoot)) {
    for (const entry of readdirSync(options.vaultRoot, {
      withFileTypes: true,
    })) {
      if (entry.isDirectory() && entry.name.startsWith('.recover-work-')) {
        rmSync(path.join(options.vaultRoot, entry.name), {
          recursive: true,
          force: true,
        });
      }
    }
  }
  removeIfEmpty(options.vaultRoot);
  removeIfEmpty(options.cacheRoot);
  return removed;
}
