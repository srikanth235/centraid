import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest';

import { IndexedDbIntentStore } from './intent-store.js';
import { IntentQueue } from './intents.js';

const payload = {
  intentId: 'shared-tab-intent',
  appId: 'agenda',
  action: 'complete',
  input: { taskId: 'task-1' },
  optimistic: [
    {
      op: 'upsert' as const,
      shapeId: 'shape-agenda',
      entity: 'core.task',
      rowId: 'task-1',
      values: { status: 'done' },
    },
  ],
};

describe('Replica multi-writer contract', () => {
  test('two tab coordinators share one durable intent and one canonical claim', async () => {
    const { factory, name, stores, tabA, tabB } = await openTabs();
    cleanupDatabase(factory, name, stores);

    const [fromA, fromB] = await Promise.all([tabA.enqueue(payload), tabB.enqueue(payload)]);
    expect(fromB).toEqual(fromA);
    expect(await tabA.list()).toEqual([fromA]);

    // Concurrent send loops cannot both claim the one canonical write.
    const claims = await Promise.all([tabA.claimNext(), tabB.claimNext()]);
    expect(claims.filter(Boolean)).toEqual([
      expect.objectContaining({
        intentId: payload.intentId,
        state: 'sending',
        attempts: 1,
      }),
    ]);

    // A fresh tab after both original connections close observes the claimed
    // row, then atomically settles it. This is persistence and cross-connection
    // serialization at the same IndexedDB boundary the PWA uses.
    tabA.close();
    tabB.close();
    const reopenedStore = await IndexedDbIntentStore.open(name, factory);
    stores.push(reopenedStore);
    const reopenedTab = new IntentQueue(reopenedStore);
    expect(await reopenedTab.list()).toEqual([claims.find(Boolean)]);
    await reopenedTab.applyOutcomes([{ intentId: payload.intentId, status: 'executed' }]);
    expect(await reopenedTab.list()).toEqual([]);
    expect(await reopenedTab.overlayMutations()).toEqual([]);
  });

  test('two tabs cannot reuse one canonical id for divergent payloads', async () => {
    const { factory, name, stores, tabA, tabB } = await openTabs();
    cleanupDatabase(factory, name, stores);
    await tabA.enqueue(payload);

    await expect(tabB.enqueue({ ...payload, input: { taskId: 'different-task' } })).rejects.toThrow(
      'reused with another payload',
    );
    expect(await tabA.list()).toHaveLength(1);
  });

  // #496 P3 / web.concurrency double-write: concurrent optimistic enqueue of
  // *distinct* intent ids must both survive, and only one claimer may own each.
  test('two tabs double-write distinct intents: both durable, claims exclusive per intent', async () => {
    const { factory, name, stores, tabA, tabB } = await openTabs();
    cleanupDatabase(factory, name, stores);

    const payloadA = {
      ...payload,
      intentId: 'tab-a-intent',
      optimistic: [
        {
          op: 'upsert' as const,
          shapeId: 'shape-agenda',
          entity: 'core.task',
          rowId: 'task-a',
          values: { status: 'done' },
        },
      ],
    };
    const payloadB = {
      ...payload,
      intentId: 'tab-b-intent',
      optimistic: [
        {
          op: 'upsert' as const,
          shapeId: 'shape-agenda',
          entity: 'core.task',
          rowId: 'task-b',
          values: { status: 'done' },
        },
      ],
    };

    const [fromA, fromB] = await Promise.all([tabA.enqueue(payloadA), tabB.enqueue(payloadB)]);
    expect(fromA.intentId).toBe('tab-a-intent');
    expect(fromB.intentId).toBe('tab-b-intent');
    expect(await tabA.list()).toHaveLength(2);
    expect(await tabB.list()).toHaveLength(2);

    // Race both claim loops: each intent is claimed exactly once across tabs.
    const firstClaims = await Promise.all([tabA.claimNext(), tabB.claimNext()]);
    const claimedIds = firstClaims
      .filter(Boolean)
      .map((c) => c!.intentId)
      .sort();
    expect(claimedIds).toEqual(['tab-a-intent', 'tab-b-intent']);

    // No third claim while both are in-flight.
    expect(await tabA.claimNext()).toBeFalsy();
    expect(await tabB.claimNext()).toBeFalsy();
  });
});

beforeEach(() => vi.stubGlobal('IDBKeyRange', IDBKeyRange));
afterEach(() => vi.unstubAllGlobals());

async function openTabs(): Promise<{
  factory: IDBFactory;
  name: string;
  stores: IndexedDbIntentStore[];
  tabA: IntentQueue;
  tabB: IntentQueue;
}> {
  const factory = new IDBFactory();
  const name = `centraid-multi-writer-${crypto.randomUUID()}`;
  const stores = await Promise.all([
    IndexedDbIntentStore.open(name, factory),
    IndexedDbIntentStore.open(name, factory),
  ]);
  return {
    factory,
    name,
    stores,
    tabA: new IntentQueue(stores[0]),
    tabB: new IntentQueue(stores[1]),
  };
}

function cleanupDatabase(factory: IDBFactory, name: string, stores: IndexedDbIntentStore[]): void {
  onTestFinished(async () => {
    for (const store of stores) store.close();
    await new Promise<void>((resolve, reject) => {
      const request = factory.deleteDatabase(name);
      request.addEventListener('success', () => resolve());
      request.addEventListener('error', () => reject(request.error));
    });
  });
}
