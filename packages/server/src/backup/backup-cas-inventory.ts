import { openRemoteBackupProvider } from "@centraid/backup";
import { readBlobStoreSettings, ReplicaIndex } from "@centraid/vault";
import type { ReplicaStore, VaultDb } from "@centraid/vault";

import { collectInventory } from "./backup-provider-observability.js";
import type { CollectedInventory } from "./backup-provider-observability.js";
import type { StorageConnectionStore } from "./storage-connections.js";

export interface CasInventoryResult {
  configured: boolean;
  collection?: CollectedInventory;
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
  const failures =
    store === "cas" ? await authenticatedFailures(db, collection, store) : [];
  return {
    configured: true,
    collection,
    ...(failures.length > 0 ? { authenticatedFailures: failures } : {}),
  };
}

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
