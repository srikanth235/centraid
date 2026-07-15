import type { DatabaseSync } from 'node:sqlite';
import { sealedColumnsOf } from '../schema/sealed.js';

/**
 * Host protocol credentials are identity material, not app data. They are
 * intentionally unavailable to every replica even though they predate the
 * sealed-column registry and therefore are not ciphertext-backed cells.
 */
const REPLICA_PROTOCOL_CREDENTIAL_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  'consent.app': ['signing_key'],
  'agent.agent': ['host_key'],
  'consent.device': ['public_key'],
};

/** One structural deny-list shared by log snapshots, bootstrap, and lazy reads. */
export function replicaUnavailableColumnsOf(
  entity: string,
  vault?: DatabaseSync,
): readonly string[] {
  return [
    ...new Set([
      ...sealedColumnsOf(entity, vault),
      ...(REPLICA_PROTOCOL_CREDENTIAL_COLUMNS[entity] ?? []),
    ]),
  ];
}
