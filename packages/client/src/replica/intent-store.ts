import { ReplicaProtocolError } from './errors.js';
import type { IntentState, ReplicaIntent } from './types.js';

export { MemoryIntentStore } from './memory-intent-store.js';

export type NewStoredIntent = Omit<ReplicaIntent, 'createdOrder'>;

export interface IntentRecordStore {
  add(intent: NewStoredIntent): Promise<ReplicaIntent>;
  get(intentId: string): Promise<ReplicaIntent | undefined>;
  list(states?: readonly IntentState[]): Promise<ReplicaIntent[]>;
  claimNext(): Promise<ReplicaIntent | undefined>;
  transition(
    intentId: string,
    allowed: readonly IntentState[],
    patch: Partial<ReplicaIntent>,
  ): Promise<ReplicaIntent>;
  /** Return the settled value while atomically removing its sensitive input. */
  settle(
    intentId: string,
    allowed: readonly IntentState[],
    patch: Partial<ReplicaIntent>,
  ): Promise<ReplicaIntent>;
  clear(): Promise<void>;
  close(): void;
  destroy(): Promise<void>;
}

const INTENTS = 'intents';
const META = 'meta';
const INTENT_STORE_VERSION = 2;
const STATE_CREATED_ORDER = 'stateCreatedOrder';

interface IntentMeta {
  key: 'nextOrder';
  value: number;
}

export class IndexedDbIntentStore implements IntentRecordStore {
  private constructor(
    private readonly name: string,
    private readonly db: IDBDatabase,
    private readonly factory: IDBFactory,
  ) {}

  static async open(name: string, factory: IDBFactory = indexedDB): Promise<IndexedDbIntentStore> {
    const request = factory.open(name, INTENT_STORE_VERSION);
    request.addEventListener('upgradeneeded', () => {
      const db = request.result;
      // v0 has no migration contract. Rebuild this cache whenever its access
      // pattern changes so no legacy full-history store survives an upgrade.
      for (const storeName of Array.from(db.objectStoreNames)) {
        db.deleteObjectStore(storeName);
      }
      const intents = db.createObjectStore(INTENTS, { keyPath: 'intentId' });
      intents.createIndex('createdOrder', 'createdOrder', { unique: true });
      intents.createIndex(STATE_CREATED_ORDER, ['state', 'createdOrder'], { unique: true });
      db.createObjectStore(META, { keyPath: 'key' });
    });
    const db = await requestResult(request);
    return new IndexedDbIntentStore(name, db, factory);
  }

  async add(intent: NewStoredIntent): Promise<ReplicaIntent> {
    const tx = this.db.transaction([INTENTS, META], 'readwrite');
    const intents = tx.objectStore(INTENTS);
    const existing = (await requestResult(intents.get(intent.intentId))) as
      | ReplicaIntent
      | undefined;
    if (existing) {
      await transactionDone(tx);
      if (existing.payloadHash !== intent.payloadHash) {
        throw new ReplicaProtocolError(
          `Intent id ${intent.intentId} was reused with another payload`,
        );
      }
      return clone(existing);
    }
    const metaStore = tx.objectStore(META);
    const meta = (await requestResult(metaStore.get('nextOrder'))) as IntentMeta | undefined;
    const createdOrder = meta?.value ?? 1;
    const record: ReplicaIntent = { ...clone(intent), createdOrder };
    intents.add(record);
    metaStore.put({ key: 'nextOrder', value: createdOrder + 1 } satisfies IntentMeta);
    await transactionDone(tx);
    return clone(record);
  }

  async get(intentId: string): Promise<ReplicaIntent | undefined> {
    const tx = this.db.transaction(INTENTS, 'readonly');
    const value = (await requestResult(tx.objectStore(INTENTS).get(intentId))) as
      | ReplicaIntent
      | undefined;
    await transactionDone(tx);
    return value ? clone(value) : undefined;
  }

  async list(states?: readonly IntentState[]): Promise<ReplicaIntent[]> {
    const tx = this.db.transaction(INTENTS, 'readonly');
    const store = tx.objectStore(INTENTS);
    const values = states
      ? await Promise.all(
          [...new Set(states)].map(
            async (state) =>
              (await requestResult(
                store.index(STATE_CREATED_ORDER).getAll(intentStateRange(state)),
              )) as ReplicaIntent[],
          ),
        ).then((groups) => groups.flat().sort(byCreatedOrder))
      : ((await requestResult(store.index('createdOrder').getAll())) as ReplicaIntent[]);
    await transactionDone(tx);
    return values.map(clone);
  }

  async claimNext(): Promise<ReplicaIntent | undefined> {
    const tx = this.db.transaction(INTENTS, 'readwrite');
    const store = tx.objectStore(INTENTS);
    const cursor = await requestResult(
      store.index(STATE_CREATED_ORDER).openCursor(intentStateRange('queued')),
    );
    if (!cursor) {
      await transactionDone(tx);
      return undefined;
    }
    const queued = cursor.value as ReplicaIntent;
    const claimed: ReplicaIntent = {
      ...queued,
      state: 'sending',
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
    patch: Partial<ReplicaIntent>,
  ): Promise<ReplicaIntent> {
    const tx = this.db.transaction(INTENTS, 'readwrite');
    const store = tx.objectStore(INTENTS);
    const existing = (await requestResult(store.get(intentId))) as ReplicaIntent | undefined;
    if (!existing) {
      tx.abort();
      throw new ReplicaProtocolError(`Unknown intent ${intentId}`);
    }
    if (!allowed.includes(existing.state)) {
      tx.abort();
      throw new ReplicaProtocolError(`Intent ${intentId} cannot transition from ${existing.state}`);
    }
    const updated = { ...existing, ...clone(patch), intentId, createdOrder: existing.createdOrder };
    store.put(updated);
    await transactionDone(tx);
    return clone(updated);
  }

  async settle(
    intentId: string,
    allowed: readonly IntentState[],
    patch: Partial<ReplicaIntent>,
  ): Promise<ReplicaIntent> {
    const tx = this.db.transaction(INTENTS, 'readwrite');
    const store = tx.objectStore(INTENTS);
    const existing = (await requestResult(store.get(intentId))) as ReplicaIntent | undefined;
    if (!existing) {
      tx.abort();
      throw new ReplicaProtocolError(`Unknown intent ${intentId}`);
    }
    if (!allowed.includes(existing.state)) {
      tx.abort();
      throw new ReplicaProtocolError(`Intent ${intentId} cannot settle from ${existing.state}`);
    }
    const settled = { ...existing, ...clone(patch), intentId, createdOrder: existing.createdOrder };
    store.delete(intentId);
    await transactionDone(tx);
    return clone(settled);
  }

  async clear(): Promise<void> {
    const tx = this.db.transaction([INTENTS, META], 'readwrite');
    tx.objectStore(INTENTS).clear();
    tx.objectStore(META).clear();
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

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () =>
      reject(request.error ?? new Error('IndexedDB request failed')),
    );
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve());
    transaction.addEventListener('error', () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed')),
    );
    transaction.addEventListener('abort', () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted')),
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
