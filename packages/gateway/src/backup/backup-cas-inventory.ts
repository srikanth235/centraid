/* Raw/provider CAS inventory resolution for the gateway audit (issue #414). */

import {
  S3ObjectStore,
  openRemoteBackupProvider,
  type ProviderInventoryObject,
  type S3Grant,
} from '@centraid/backup';
import {
  readBlobStoreSettings,
  ReplicaIndex,
  type ReplicaStore,
  type VaultDb,
} from '@centraid/vault';
import { collectInventory, type CollectedInventory } from './backup-provider-observability.js';
import type { StorageConnectionStore } from './storage-connections.js';

export interface CasInventoryResult {
  configured: boolean;
  collection?: CollectedInventory;
  /** Same-key objects that failed the vault content-key AEAD audit. */
  authenticatedFailures?: string[];
  error?: string;
}

function s3Prefix(prefix: string | undefined): string {
  const clean = prefix?.replace(/^\/+|\/+$/g, '');
  return clean ? `${clean}/` : '';
}

async function collectOwnS3(
  storage: StorageConnectionStore,
  connectionId: string,
  store: ReplicaStore,
  prefix: string | undefined,
): Promise<CollectedInventory> {
  const connection = await storage.get(connectionId);
  if (
    !connection ||
    connection.kind !== 'byo-s3' ||
    !connection.endpoint ||
    !connection.region ||
    !connection.bucket
  ) {
    throw new Error(`CAS connection "${connectionId}" is not a complete own-S3 connection`);
  }
  const credentials = await storage.resolveS3Credentials(connectionId);
  const grant: S3Grant = {
    endpoint: connection.endpoint,
    region: connection.region,
    bucket: connection.bucket,
    // The derived store shares the bucket; only the prefix differs (issue #425
    // Wave 2), so list under whichever prefix this store class occupies.
    prefix: s3Prefix(prefix),
    store,
    ...credentials,
    expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    mode: 'read',
  };
  const objectStore = new S3ObjectStore(grant);
  const objects: ProviderInventoryObject[] = [];
  for await (const row of objectStore.list('')) {
    objects.push({
      key: row.key,
      sizeBytes: row.size,
      etagOrHash: row.etagOrHash ?? '',
      storedAt: row.storedAt ?? 0,
      ...(row.storageClass ? { storageClass: row.storageClass } : {}),
      state: 'live',
    });
  }
  return { source: 'bucket', providerAttested: false, objects };
}

function casSha(key: string): string | undefined {
  return /(?:^|\/)blobs\/(?:sha256\/)?([0-9a-f]{64})$/.exec(key)?.[1];
}

async function authenticatedFailures(
  db: VaultDb,
  collection: CollectedInventory,
  store: ReplicaStore,
): Promise<string[]> {
  const remote = new Set(
    collection.objects
      .filter((object) => object.state === 'live')
      .map((object) => casSha(object.key))
      .filter((sha): sha is string => sha !== undefined),
  );
  const index = new ReplicaIndex(db.vault);
  const failures: string[] = [];
  // Scope the AEAD re-audit to THIS store's rows (issue #425 Wave 2): a cas
  // listing must never disprove derived evidence, and vice-versa.
  for (const sha of index.all(store)) {
    if (!remote.has(sha)) continue;
    try {
      await db.blobTransfers.auditRemoteReplica(sha);
    } catch {
      index.unmark(sha);
      failures.push(sha);
    }
  }
  return failures.sort();
}

async function verifiedResult(
  db: VaultDb,
  collection: CollectedInventory,
  store: ReplicaStore,
): Promise<CasInventoryResult> {
  // The AEAD re-audit reads via `auditRemoteReplica`, which addresses the cas
  // store; run it only for cas. The derived pass is presence-diff only (its
  // missing/orphan drift still surfaces + unmarks in the reconciler).
  const failures = store === 'cas' ? await authenticatedFailures(db, collection, store) : [];
  return {
    configured: true,
    collection,
    ...(failures.length > 0 ? { authenticatedFailures: failures } : {}),
  };
}

/**
 * Collect one store class's remote inventory (issue #425 Wave 2). `store`
 * defaults to `cas` — the original behavior byte-for-byte. `derived` returns
 * `{configured:false}` when the vault has no `derivedPrefix` (the target never
 * granted the store), so the reconciler simply skips the derived pass.
 */
export async function collectCasInventory(opts: {
  db: VaultDb;
  storageConnections?: StorageConnectionStore;
  verifyBucket: boolean;
  store?: ReplicaStore;
}): Promise<CasInventoryResult> {
  const store = opts.store ?? 'cas';
  const settings = readBlobStoreSettings(opts.db.vault);
  if (settings.kind !== 's3') return { configured: false };
  if (store === 'derived' && !settings.derivedPrefix) return { configured: false };
  if (!settings.connectionId || !opts.storageConnections) {
    return {
      configured: true,
      error: 'CAS is configured without a storage connection available to inventory',
    };
  }
  try {
    const connection = await opts.storageConnections.get(settings.connectionId);
    if (connection?.kind === 'byo-s3') {
      const prefix = store === 'derived' ? settings.derivedPrefix : connection.prefix;
      return verifiedResult(
        opts.db,
        await collectOwnS3(opts.storageConnections, settings.connectionId, store, prefix),
        store,
      );
    }
    if (!connection?.baseUrl || !connection.targetId) {
      throw new Error(`provider CAS connection "${settings.connectionId}" has no target`);
    }
    const apiKey = await opts.storageConnections.resolveProviderApiKey(settings.connectionId);
    const provider = openRemoteBackupProvider({ baseUrl: connection.baseUrl, apiKey });
    return verifiedResult(
      opts.db,
      await collectInventory({
        provider,
        targetId: connection.targetId,
        store,
        verifyBucket: opts.verifyBucket,
      }),
      store,
    );
  } catch (err) {
    return {
      configured: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
