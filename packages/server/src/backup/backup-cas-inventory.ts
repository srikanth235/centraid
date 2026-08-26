/* Provider CAS inventory resolution for the gateway audit (#414). Every
 * storage connection is a provider connection (#436), so inventory always
 * comes from the provider's attested `listInventory` capability; there is no
 * direct own-S3 bucket listing. */

import { openRemoteBackupProvider } from "@centraid/backup";
import { readBlobStoreSettings, ReplicaIndex } from "@centraid/vault";
import type { ReplicaStore, VaultDb } from "@centraid/vault";

import { collectInventory } from "./backup-provider-observability.js";
import type { CollectedInventory } from "./backup-provider-observability.js";
import type { StorageConnectionStore } from "./storage-connections.js";

export interface CasInventoryResult {
  configured: boolean;
  collection?: CollectedInventory;
  /** Same-key objects that failed the vault content-key AEAD audit. */
  authenticatedFailures?: string[];
  error?: string;
}

function casSha(key: string): string | undefined {
  return /(?:^|\/)blobs\/(?:sha256\/)?(?<sha>[0-9a-f]{64})$/u.exec(key)?.groups
    ?.sha;
}

async function authenticatedFailures(
  db: VaultDb,
  collection: CollectedInventory,
  store: ReplicaStore
): Promise<string[]> {
  const remote = new Set(
    collection.objects
      .filter((object) => object.state === "live")
      .map((object) => casSha(object.key))
      .filter((sha): sha is string => sha !== undefined)
  );
  const index = new ReplicaIndex(db.vault);
  const failures: string[] = [];
  // Scope the AEAD re-audit to THIS store's rows (#425): a cas
  // listing must never disprove derived evidence, and vice-versa.
  const audits = await Promise.all(
    [...index.all(store)]
      .filter((sha) => remote.has(sha))
      .map(async (sha) => {
        try {
          await db.blobTransfers.auditRemoteReplica(sha);
          return undefined;
        } catch {
          index.unmark(sha);
          return sha;
        }
      })
  );
  failures.push(...audits.filter((sha): sha is string => sha !== undefined));
  return failures.sort();
}

async function verifiedResult(
  db: VaultDb,
  collection: CollectedInventory,
  store: ReplicaStore
): Promise<CasInventoryResult> {
  // The AEAD re-audit reads via `auditRemoteReplica`, which addresses the cas
  // store; run it only for cas. The derived pass is presence-diff only (its
  // missing/orphan drift still surfaces + unmarks in the reconciler).
  const failures =
    store === "cas" ? await authenticatedFailures(db, collection, store) : [];
  return {
    configured: true,
    collection,
    ...(failures.length > 0 ? { authenticatedFailures: failures } : {}),
  };
}

/**
 * Collect one store class's remote inventory (#425). `store`
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
  const store = opts.store ?? "cas";
  const settings = readBlobStoreSettings(opts.db.vault);
  if (settings.kind !== "s3") return { configured: false };
  if (store === "derived" && !settings.derivedPrefix)
    return { configured: false };
  if (!settings.connectionId || !opts.storageConnections) {
    return {
      configured: true,
      error:
        "CAS is configured without a storage connection available to inventory",
    };
  }
  try {
    const connection = await opts.storageConnections.get(settings.connectionId);
    if (!connection?.baseUrl || !connection.targetId) {
      throw new Error(
        `provider CAS connection "${settings.connectionId}" has no target`
      );
    }
    const apiKey = await opts.storageConnections.resolveProviderApiKey(
      settings.connectionId
    );
    const provider = openRemoteBackupProvider({
      baseUrl: connection.baseUrl,
      apiKey,
    });
    return verifiedResult(
      opts.db,
      await collectInventory({
        provider,
        targetId: connection.targetId,
        store,
        verifyBucket: opts.verifyBucket,
      }),
      store
    );
  } catch (error) {
    return {
      configured: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
