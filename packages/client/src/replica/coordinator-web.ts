import { ReplicaCoordinator } from "./coordinator.js";
import type {
  ReplicaCoordinatorCreated,
  ReplicaCoordinatorOptions,
} from "./coordinator.js";
import type { IntentRecordStore } from "./intent-record-store.js";
import { IndexedDbIntentStore, MemoryIntentStore } from "./intent-store.js";
import { IntentQueue } from "./intents.js";
import { replicaIntentDatabaseName } from "./key.js";
import type { ReplicaIdentity } from "./types.js";
import { ReplicaWorkerClient } from "./worker-client.js";
import type { ReplicaWorkerFactory } from "./worker-client.js";

export interface ReplicaWebCoordinatorOptions extends ReplicaCoordinatorOptions {
  workerFactory?: ReplicaWorkerFactory;
  intentStore?: IntentRecordStore;
  indexedDbFactory?: IDBFactory;
}

export async function createReplicaCoordinator(
  identity: ReplicaIdentity,
  remember: boolean,
  options: ReplicaWebCoordinatorOptions = {}
): Promise<ReplicaCoordinatorCreated> {
  const { client, status } = await ReplicaWorkerClient.create(
    identity,
    remember,
    options.workerFactory
  );
  try {
    const store =
      options.intentStore ??
      (status.mode === "opfs-sahpool" &&
      (options.indexedDbFactory ?? globalThis.indexedDB)
        ? await openIndexedDb(
            identity,
            options.indexedDbFactory ?? globalThis.indexedDB
          )
        : new MemoryIntentStore());
    const intentDurability =
      store instanceof MemoryIntentStore ? "memory" : "durable";
    const intents = new IntentQueue(store, {
      ...(options.idFactory ? { idFactory: options.idFactory } : {}),
      ...(options.digest ? { digest: options.digest } : {}),
    });
    if (status.cursor && options.changeFeed) {
      const shapeIds = (await client.catalog()).map((shape) => shape.shapeId);
      await options.changeFeed.setShapeIds(shapeIds);
      await options.changeFeed.resume(status.cursor);
    }
    return {
      replica: new ReplicaCoordinator(client, intents, options),
      status: { ...status, intentDurability },
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function openIndexedDb(
  identity: ReplicaIdentity,
  factory: IDBFactory
): Promise<IntentRecordStore> {
  try {
    return await IndexedDbIntentStore.open(
      await replicaIntentDatabaseName(identity),
      factory
    );
  } catch {
    return new MemoryIntentStore();
  }
}
