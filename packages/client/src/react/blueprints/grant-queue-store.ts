import type {
  GrantIntentQueue,
  QueuedGrantIntent,
} from "@centraid/blueprints/apps/_shared/grant-transport";

const DB_NAME = "centraid-grant-queue";
const STORE = "intents";
const VERSION = 1;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("indexeddb request failed"))
    );
  });
}

export function grantIntentQueue(db: IDBDatabase): GrantIntentQueue {
  const tx = (mode: IDBTransactionMode): IDBObjectStore =>
    db.transaction(STORE, mode).objectStore(STORE);
  return {
    async list() {
      return (await requestResult(
        tx("readonly").getAll()
      )) as QueuedGrantIntent[];
    },
    async append(intent) {
      await requestResult(tx("readwrite").add(intent));
    },
    async remove(intentId) {
      const store = tx("readwrite");
      const key = await requestResult(store.index("intentId").getKey(intentId));
      if (key === undefined) return;
      await requestResult(store.delete(key));
    },
  };
}

export async function openGrantIntentQueue(
  factory: IDBFactory | undefined = globalThis.indexedDB
): Promise<GrantIntentQueue | undefined> {
  if (!factory) return undefined;
  try {
    const request = factory.open(DB_NAME, VERSION);
    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      const store = db.objectStoreNames.contains(STORE)
        ? request.transaction!.objectStore(STORE)
        : db.createObjectStore(STORE, { autoIncrement: true });
      if (!store.indexNames.contains("intentId"))
        store.createIndex("intentId", "intentId", { unique: true });
    });
    return grantIntentQueue(await requestResult(request));
  } catch {
    return undefined;
  }
}
