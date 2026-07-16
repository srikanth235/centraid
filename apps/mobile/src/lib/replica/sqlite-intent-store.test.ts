// Proves SqliteIntentStore matches the durable-outbox spec by running the same
// conformance corpus against it and the reference MemoryIntentStore.
import { describe, expect, test } from 'vitest';

import {
  MemoryIntentStore,
  ReplicaProtocolError,
  type IntentRecordStore,
  type NewStoredIntent,
} from '@centraid/client/replica/native';

import { NodeSqliteDriver } from './node-sqlite-driver';
import { SqliteIntentStore } from './sqlite-intent-store';

function newIntent(overrides: Partial<NewStoredIntent> = {}): NewStoredIntent {
  return {
    intentId: 'intent-1',
    payloadHash: 'hash-1',
    appId: 'photos',
    action: 'rename',
    input: { title: 'Beach' },
    state: 'queued',
    attempts: 0,
    optimistic: [],
    dependencies: [],
    ...overrides,
  };
}

function runIntentStoreConformance(makeStore: () => IntentRecordStore): void {
  test('add is idempotent for the same id and payload hash', async () => {
    const store = makeStore();
    const first = await store.add(newIntent());
    const again = await store.add(newIntent());
    expect(again).toEqual(first);
    expect(await store.list()).toHaveLength(1);
  });

  test('add rejects a reused id carrying a different payload', async () => {
    const store = makeStore();
    await store.add(newIntent());
    await expect(store.add(newIntent({ payloadHash: 'hash-2' }))).rejects.toBeInstanceOf(
      ReplicaProtocolError,
    );
  });

  test('assigns strictly increasing createdOrder that survives deletes', async () => {
    const store = makeStore();
    const a = await store.add(newIntent({ intentId: 'a' }));
    const b = await store.add(newIntent({ intentId: 'b' }));
    expect(b.createdOrder).toBeGreaterThan(a.createdOrder);
    await store.settle('a', ['queued'], { state: 'executed' });
    const c = await store.add(newIntent({ intentId: 'c' }));
    expect(c.createdOrder).toBeGreaterThan(b.createdOrder);
  });

  test('claimNext atomically moves the oldest queued intent to sending', async () => {
    const store = makeStore();
    await store.add(newIntent({ intentId: 'a' }));
    await store.add(newIntent({ intentId: 'b' }));
    const claimed = await store.claimNext();
    expect(claimed?.intentId).toBe('a');
    expect(claimed?.state).toBe('sending');
    expect(claimed?.attempts).toBe(1);
    expect((await store.get('a'))?.state).toBe('sending');
    expect((await store.claimNext())?.intentId).toBe('b');
    expect(await store.claimNext()).toBeUndefined();
  });

  test('transition enforces the allowed states and clears reason on undefined', async () => {
    const store = makeStore();
    await store.add(newIntent());
    await store.claimNext();
    await store.transition('intent-1', ['sending'], { state: 'queued', reason: 'network' });
    expect((await store.get('intent-1'))?.reason).toBe('network');
    await store.claimNext();
    const cleared = await store.transition('intent-1', ['sending'], {
      state: 'awaiting-change',
      reason: undefined,
    });
    expect(cleared.state).toBe('awaiting-change');
    expect(cleared.reason).toBeUndefined();
    await expect(
      store.transition('intent-1', ['sending'], { state: 'queued' }),
    ).rejects.toBeInstanceOf(ReplicaProtocolError);
    await expect(store.transition('missing', ['queued'], {})).rejects.toBeInstanceOf(
      ReplicaProtocolError,
    );
  });

  test('settle returns the settled value and deletes the row (scrubbing input)', async () => {
    const store = makeStore();
    await store.add(newIntent());
    await store.claimNext();
    const settled = await store.settle('intent-1', ['sending'], {
      state: 'executed',
      output: { ok: true },
    });
    expect(settled.state).toBe('executed');
    expect(settled.output).toEqual({ ok: true });
    expect(await store.get('intent-1')).toBeUndefined();
    expect(await store.list()).toHaveLength(0);
  });

  test('list filters by state in createdOrder', async () => {
    const store = makeStore();
    await store.add(newIntent({ intentId: 'a' }));
    await store.add(newIntent({ intentId: 'b' }));
    await store.add(newIntent({ intentId: 'c' }));
    await store.claimNext(); // a -> sending
    expect((await store.list(['queued'])).map((intent) => intent.intentId)).toEqual(['b', 'c']);
    expect((await store.list(['sending'])).map((intent) => intent.intentId)).toEqual(['a']);
  });

  test('clear empties the store', async () => {
    const store = makeStore();
    await store.add(newIntent({ intentId: 'a' }));
    await store.add(newIntent({ intentId: 'b' }));
    await store.clear();
    expect(await store.list()).toHaveLength(0);
  });
}

describe('MemoryIntentStore (reference)', () => {
  runIntentStoreConformance(() => new MemoryIntentStore());
});

describe('SqliteIntentStore (node:sqlite stand-in)', () => {
  runIntentStoreConformance(() => SqliteIntentStore.create(new NodeSqliteDriver()));
});
