import type { ReplicaIdentity } from './types.js';

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Opaque, non-secret namespace shared by SQLite, IDB and Cache Storage. */
export async function replicaStorageKey(identity: ReplicaIdentity): Promise<string> {
  const source = `${identity.gatewayId}\u0000${identity.vaultId}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return hex(digest);
}

/** SAH-pool virtual names must be absolute. */
export async function replicaDatabaseName(identity: ReplicaIdentity): Promise<string> {
  return `/centraid-replica-${await replicaStorageKey(identity)}.sqlite3`;
}

export async function replicaIntentDatabaseName(identity: ReplicaIdentity): Promise<string> {
  return `centraid-replica-intents-${await replicaStorageKey(identity)}`;
}
