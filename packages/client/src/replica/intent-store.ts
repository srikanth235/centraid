import { ReplicaProtocolError } from "./errors.js";
import type {
  IntentRecordStore,
  NewStoredIntent,
} from "./intent-record-store.js";
import { buildIntentOutcome } from "./intent-record-store.js";
import type { IntentOutcome, IntentState, ReplicaIntent } from "./types.js";

export { MemoryIntentStore } from "./memory-intent-store.js";
export type {
  IntentRecordStore,
  NewStoredIntent,
} from "./intent-record-store.js";

const INTENTS = "intents";
const META = "meta";
const OUTCOMES = "outcomes";
const INTENT_STORE_VERSION = 3;
const STATE_CREATED_ORDER = "stateCreatedOrder";
const SETTLED_JOURNAL_LIMIT = 5_000;

interface IntentMeta {
  key: "nextOrder";
  value: number;
}

export class IndexedDbIntentStore implements IntentRecordStore {
  private constructor(
    private readonly name: string,
    private readonly db: IDBDatabase,
    private readonly factory: IDBFactory
  ) {}

  static async open(
    name: string,
    factory: IDBFactory = indexedDB
  ): Promise<IndexedDbIntentStore> {
    const request = factory.open(name, INTENT_STORE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      const intents = db.objectStoreNames.contains(INTENTS)
        ? request.transaction!.objectStore(INTENTS)
        : db.createObjectStore(INTENTS, { keyPath: "intentId" });
      if (!intents.indexNames.contains("createdOrder"))
        intents.createIndex("createdOrder", "createdOrder", { unique: true });
      if (!intents.indexNames.contains(STATE_CREATED_ORDER))
        intents.createIndex(STATE_CREATED_ORDER, ["state", "createdOrder"], {
          unique: true,
        });
      if (!db.objectStoreNames.contains(META))
        db.createObjectStore(META, { keyPath: "key" });
      if (!db.objectStoreNames.contains(OUTCOMES))
        db.createObjectStore(OUTCOMES, { keyPath: "intentId" });
    });
    const db = await requestResult(request);
    return new IndexedDbIntentStore(name, db, factory);
  }

  async add(intent: NewStoredIntent): Promise<ReplicaIntent> {
    const tx = this.db.transaction([INTENTS, META], "readwrite");
    const intents = tx.objectStore(INTENTS);
    const existing = (await requestResult(intents.get(intent.intentId))) as
      | ReplicaIntent
      | undefined;
    if (existing) {
      await transactionDone(tx);
      if (existing.payloadHash !== intent.payloadHash) {
        throw new ReplicaProtocolError(
          `Intent id ${intent.intentId} was reused with another payload`
        );
      }
      return clone(existing);
    }
    const metaStore = tx.objectStore(META);
    const meta = (await requestResult(metaStore.get("nextOrder"))) as
      | IntentMeta
      | undefined;
    const createdOrder = meta?.value ?? 1;
    const record: ReplicaIntent = { ...clone(intent), createdOrder };
    intents.add(record);
    metaStore.put({
      key: "nextOrder",
      value: createdOrder + 1,
    } satisfies IntentMeta);
    await transactionDone(tx);
    return clone(record);
  }

  async get(intentId: string): Promise<ReplicaIntent | undefined> {
    const tx = this.db.transaction(INTENTS, "readonly");
    const value = (await requestResult(
      tx.objectStore(INTENTS).get(intentId)
    )) as ReplicaIntent | undefined;
    await transactionDone(tx);
    return value ? clone(value) : undefined;
  }

  async list(states?: readonly IntentState[]): Promise<ReplicaIntent[]> {
    const tx = this.db.transaction(INTENTS, "readonly");
    const store = tx.objectStore(INTENTS);
    const values = states
      ? await Promise.all(
          [...new Set(states)].map(
            async (state) =>
              (await requestResult(
                store.index(STATE_CREATED_ORDER).getAll(intentStateRange(state))
              )) as ReplicaIntent[]
          )
        ).then((groups) => groups.flat().sort(byCreatedOrder))
      : ((await requestResult(
          store.index("createdOrder").getAll()
        )) as ReplicaIntent[]);
    await transactionDone(tx);
    return values.map(clone);
  }

  async claimNext(): Promise<ReplicaIntent | undefined> {
    const tx = this.db.transaction(INTENTS, "readwrite");
    const store = tx.objectStore(INTENTS);
    const cursor = await requestResult(
      store.index(STATE_CREATED_ORDER).openCursor(intentStateRange("queued"))
    );
    if (!cursor) {
      await transactionDone(tx);
      return undefined;
    }
    const queued = cursor.value as ReplicaIntent;
    const claimed: ReplicaIntent = {
      ...queued,
      state: "sending",
      attempts: queued.attempts + 1,
      reason: undefined,
    };
    cursor.update(claimed);
    await transactionDone(tx);
    return clone(claimed);
  }

  async transition(
    intentId: string,
    allowed: readonly IntentState[],
    patch: Partial<ReplicaIntent>
  ): Promise<ReplicaIntent> {
    const tx = this.db.transaction(INTENTS, "readwrite");
    const store = tx.objectStore(INTENTS);
    const existing = (await requestResult(store.get(intentId))) as
      | ReplicaIntent
      | undefined;
    if (!existing) {
      tx.abort();
      throw new ReplicaProtocolError(`Unknown intent ${intentId}`);
    }
    if (!allowed.includes(existing.state)) {
      tx.abort();
      throw new ReplicaProtocolError(
        `Intent ${intentId} cannot transition from ${existing.state}`
      );
    }
    const updated = {
      ...existing,
      ...clone(patch),
      intentId,
      createdOrder: existing.createdOrder,
    };
    store.put(updated);
    await transactionDone(tx);
    return clone(updated);
  }

  async settle(
    intentId: string,
    allowed: readonly IntentState[],
    patch: Partial<ReplicaIntent>
  ): Promise<ReplicaIntent> {
    const tx = this.db.transaction([INTENTS, OUTCOMES], "readwrite");
    const store = tx.objectStore(INTENTS);
    const existing = (await requestResult(store.get(intentId))) as
      | ReplicaIntent
      | undefined;
    if (!existing) {
      tx.abort();
      throw new ReplicaProtocolError(`Unknown intent ${intentId}`);
    }
    if (!allowed.includes(existing.state)) {
      tx.abort();
      throw new ReplicaProtocolError(
        `Intent ${intentId} cannot settle from ${existing.state}`
      );
    }
    const settled = {
      ...existing,
      ...clone(patch),
      intentId,
      createdOrder: existing.createdOrder,
    };
    const outcome = buildIntentOutcome(settled);
    const outcomes = tx.objectStore(OUTCOMES);
    outcomes.put(clone(outcome));
    store.delete(intentId);
    await pruneOutcomeJournal(outcomes);
    await transactionDone(tx);
    return clone(settled);
  }

  async listSettled(limit = 500): Promise<IntentOutcome[]> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > SETTLED_JOURNAL_LIMIT
    )
      throw new ReplicaProtocolError("Settled outcome limit is invalid");
    const tx = this.db.transaction(OUTCOMES, "readonly");
    const values = (await requestResult(
      tx.objectStore(OUTCOMES).getAll()
    )) as IntentOutcome[];
    await transactionDone(tx);
    return values
      .sort((left, right) =>
        (right.settledAt ?? "").localeCompare(left.settledAt ?? "")
      )
      .slice(0, limit)
      .map(clone);
  }

  async clear(): Promise<void> {
    const tx = this.db.transaction([INTENTS, META, OUTCOMES], "readwrite");
    tx.objectStore(INTENTS).clear();
    tx.objectStore(META).clear();
    tx.objectStore(OUTCOMES).clear();
    await transactionDone(tx);
  }

  close(): void {
    this.db.close();
  }

  async destroy(): Promise<void> {
    this.close();
    await requestResult(this.factory.deleteDatabase(this.name));
  }
}

async function pruneOutcomeJournal(outcomes: IDBObjectStore): Promise<void> {
  const count = await requestResult(outcomes.count());
  if (count <= SETTLED_JOURNAL_LIMIT) return;
  const stored = (await requestResult(outcomes.getAll())) as IntentOutcome[];
  const expired = stored
    .sort((left, right) =>
      (right.settledAt ?? "").localeCompare(left.settledAt ?? "")
    )
    .slice(SETTLED_JOURNAL_LIMIT);
  for (const outcome of expired) outcomes.delete(outcome.intentId);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("IndexedDB request failed"))
    );
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"))
    );
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"))
    );
  });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function intentStateRange(state: IntentState): IDBKeyRange {
  return IDBKeyRange.bound([state, 0], [state, Number.MAX_SAFE_INTEGER]);
}

function byCreatedOrder(left: ReplicaIntent, right: ReplicaIntent): number {
  return left.createdOrder - right.createdOrder;
}
