import { webCryptoDigest, type ReplicaDigest } from './digest.js';
import type { ReplicaIdentity } from './types.js';

export type { ReplicaDigest };

/** Opaque, non-secret namespace shared by SQLite, IDB and Cache Storage. */
export async function replicaStorageKey(
  identity: ReplicaIdentity,
  digest: ReplicaDigest = webCryptoDigest,
): Promise<string> {
  return digest(`${identity.gatewayId}\u0000${identity.vaultId}`);
}

/** SAH-pool virtual names must be absolute. */
export async function replicaDatabaseName(
  identity: ReplicaIdentity,
  digest: ReplicaDigest = webCryptoDigest,
): Promise<string> {
  return `/centraid-replica-${await replicaStorageKey(identity, digest)}.sqlite3`;
}

export async function replicaIntentDatabaseName(
  identity: ReplicaIdentity,
  digest: ReplicaDigest = webCryptoDigest,
): Promise<string> {
  return `centraid-replica-intents-${await replicaStorageKey(identity, digest)}`;
}
