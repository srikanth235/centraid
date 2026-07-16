// governance: allow-repo-hygiene file-size-limit cohesive coordinator regression suite; splitting would obscure issue #417 review
import { describe, expect, test, vi } from 'vitest';

import type { VaultChangeMessage } from '../vault-change-feed.js';
import { ReplicaCoordinator, type ReplicaChangeFeedAdapter } from './coordinator.js';
import { createReplicaCoordinator } from './coordinator-web.js';
import { ReplicaRebootstrapRequiredError } from './errors.js';
import { MemoryIntentStore } from './intent-store.js';
import { IntentQueue } from './intents.js';
import type { ReplicaWorkerRequest, ReplicaWorkerResponse } from './worker-protocol.js';
import { ReplicaWorkerClient, type ReplicaWorkerLike } from './worker-client.js';
import type { ReplicaChangeBatch, ReplicaCursor, ReplicaSnapshot } from './types.js';

interface TestFeed extends ReplicaChangeFeedAdapter {
  readonly listener: ((message: VaultChangeMessage) => void) | undefined;
  readonly resumed: ReplicaCursor | undefined;
  emit(message: VaultChangeMessage): void;
}

function createFeed(): TestFeed {
  let listener: ((message: VaultChangeMessage) => void) | undefined;
  let resumed: ReplicaCursor | undefined;
  return {
    get listener() {
      return listener;
    },
    get resumed() {
      return resumed;
    },
    subscribe(next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    async setShapeIds() {},
    async resume(cursor) {
      resumed = cursor;
    },
    emit(message) {
      listener?.(message);
    },
  };
}

class StateWorker implements ReplicaWorkerLike {
  cursor: ReplicaCursor | null = null;
  terminated = false;
  onApply: (() => void) | undefined;
  readonly requests: ReplicaWorkerRequest[] = [];
  readonly #messages = new Set<(event: MessageEvent<ReplicaWorkerResponse>) => void>();
  readonly #errors = new Set<(event: ErrorEvent) => void>();

  postMessage(request: ReplicaWorkerRequest): void {
    this.requests.push(request);
    let result: unknown;
    if (request.op === 'open' || request.op === 'status') {
      result = { mode: 'memory', cursor: this.cursor, schemaEpoch: this.cursor ? 'schema' : null };
    } else if (request.op === 'catalog') {
      result = [];
    } else if (request.op === 'bootstrap') {
      this.cursor = request.payload.cursor;
      result = this.cursor;
    } else if (request.op === 'apply-changes') {
      this.cursor = request.payload.to;
      this.onApply?.();
      result = {
        cursor: this.cursor,
        invalidations: request.payload.changes.map((change) => ({
          shapeId: change.shapeId,
          entity: change.entity,
          rowId: change.rowId,
          source: 'canonical',
        })),
        outcomes: request.payload.outcomes ?? [],
      };
    } else if (request.op === 'wipe') {
      this.cursor = null;
    } else if (request.op === 'search') {
      result = {
        cursor: this.cursor,
        dependency: {
          shapeId: request.payload.request.shapeId,
          entity: request.payload.request.entity,
        },
        rows: [],
      };
    }
    const response: ReplicaWorkerResponse = { id: request.id, ok: true, result };
    queueMicrotask(() => {
      const event = new MessageEvent<ReplicaWorkerResponse>('message', { data: response });
      for (const listener of this.#messages) listener(event);
    });
  }

  addEventListener(
    type: 'message' | 'error',
    listener:
      | ((event: MessageEvent<ReplicaWorkerResponse>) => void)
      | ((event: ErrorEvent) => void),
  ): void {
    if (type === 'message') {
      this.#messages.add(listener as (event: MessageEvent<ReplicaWorkerResponse>) => void);
    } else {
      this.#errors.add(listener as (event: ErrorEvent) => void);
    }
  }

  removeEventListener(
    type: 'message' | 'error',
    listener:
      | ((event: MessageEvent<ReplicaWorkerResponse>) => void)
      | ((event: ErrorEvent) => void),
  ): void {
    if (type === 'message') {
      this.#messages.delete(listener as (event: MessageEvent<ReplicaWorkerResponse>) => void);
    } else {
      this.#errors.delete(listener as (event: ErrorEvent) => void);
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

const snapshot: ReplicaSnapshot = {
  protocolVersion: 1,
  vaultId: 'vault',
  schemaEpoch: 'schema',
  cursor: { epoch: 'epoch', seq: 0 },
  shapes: [],
  rows: [],
};

describe('ReplicaCoordinator', () => {
  test('uses an in-memory outbox when requested persistence falls back to memory', async () => {
    const worker = new StateWorker();
    const indexedDbFactory = {
      open: vi.fn(() => {
        throw new Error('memory fallback must not open IndexedDB');
      }),
    } as unknown as IDBFactory;
    const { replica, status } = await createReplicaCoordinator(
      { gatewayId: 'gateway', vaultId: 'vault' },
      true,
      { workerFactory: () => worker, indexedDbFactory, idFactory: () => 'memory-intent' },
    );

    expect(status.mode).toBe('memory');
    await replica.enqueue({ appId: 'agenda', action: 'create', input: { title: 'Local' } });
    expect(indexedDbFactory.open).not.toHaveBeenCalled();
    await replica.purge();
  });

  test('applies the pending intent overlay to local searches', async () => {
    const worker = new StateWorker();
    const { client } = await ReplicaWorkerClient.connect(
      { dbName: '/centraid-replica-search.sqlite3', vaultId: 'vault', remember: false },
      () => worker,
    );
    const replica = new ReplicaCoordinator(
      client,
      new IntentQueue(new MemoryIntentStore(), { idFactory: () => 'search-intent' }),
    );
    await replica.bootstrap(snapshot);
    await replica.enqueue({
      appId: 'agenda',
      action: 'rename',
      input: { eventId: 'event-1' },
      optimistic: [
        {
          op: 'upsert',
          shapeId: 'shape-agenda',
          entity: 'core.event',
          rowId: 'event-1',
          values: { summary: 'Offline planning' },
        },
      ],
    });

    await replica.searchWire({
      shapeId: 'shape-agenda',
      entity: 'core.event',
      query: 'offline',
    });

    expect(worker.requests.at(-1)).toMatchObject({
      op: 'search',
      payload: {
        request: {
          shapeId: 'shape-agenda',
          entity: 'core.event',
          query: 'offline',
        },
        mutations: [
          {
            op: 'upsert',
            shapeId: 'shape-agenda',
            entity: 'core.event',
            rowId: 'event-1',
            values: { summary: 'Offline planning' },
          },
        ],
      },
    });
    await replica.close();
  });

  test('resumes a warm OPFS cursor before attaching the shared feed', async () => {
    const worker = new StateWorker();
    worker.cursor = { epoch: 'warm', seq: 42 };
    const events: string[] = [];
    const feed: ReplicaChangeFeedAdapter = {
      async setShapeIds(shapeIds) {
        events.push(`shapes:${shapeIds.join(',')}`);
      },
      async resume(cursor) {
        events.push(`resume:${cursor.epoch}:${cursor.seq}`);
      },
      subscribe() {
        events.push('subscribe');
        return () => undefined;
      },
    };
    const { replica, status } = await createReplicaCoordinator(
      { gatewayId: 'gateway', vaultId: 'vault' },
      true,
      {
        workerFactory: () => worker,
        intentStore: new MemoryIntentStore(),
        changeFeed: feed,
        pullChanges: async () => undefined,
      },
    );
    expect(status.cursor).toEqual({ epoch: 'warm', seq: 42 });
    expect(events).toEqual(['shapes:', 'resume:warm:42', 'subscribe']);
    await replica.close();
  });

  test('uses the shared feed as a pull trigger and resolves overlays before cursor advance', async () => {
    const worker = new StateWorker();
    let applied!: () => void;
    const batchApplied = new Promise<void>((resolve) => (applied = resolve));
    worker.onApply = applied;
    const { client } = await ReplicaWorkerClient.connect(
      { dbName: '/centraid-replica-deadbeef.sqlite3', vaultId: 'vault', remember: false },
      () => worker,
    );
    const store = new MemoryIntentStore();
    const intents = new IntentQueue(store, { idFactory: () => 'intent-1' });
    const feed = createFeed();
    const pulledFrom: ReplicaCursor[] = [];
    const invalidations: unknown[] = [];
    const replica = new ReplicaCoordinator(client, intents, {
      changeFeed: feed,
      pullChanges: async (cursor) => {
        pulledFrom.push(cursor);
        return {
          protocolVersion: 1,
          schemaEpoch: 'schema',
          from: cursor,
          to: { epoch: 'epoch', seq: 1 },
          changes: [
            {
              op: 'upsert',
              shapeId: 'shape',
              entity: 'core.task',
              rowId: 'task-1',
              values: { task_id: 'task-1', status: 'done' },
            },
          ],
          outcomes: [{ intentId: 'intent-1', status: 'executed' }],
        };
      },
    });
    replica.subscribeInvalidations((items) => invalidations.push(...items));
    await replica.bootstrap(snapshot);
    expect(feed.resumed).toEqual({ epoch: 'epoch', seq: 0 });

    await replica.enqueue({
      appId: 'agenda',
      action: 'complete',
      input: { taskId: 'task-1' },
      optimistic: [
        {
          op: 'upsert',
          shapeId: 'shape',
          entity: 'core.task',
          rowId: 'task-1',
          values: { status: 'done' },
        },
      ],
    });
    await replica.claimNextIntent();
    await replica.markIntentAwaitingChange('intent-1');
    feed.emit({
      type: 'centraid:vault-change',
      detail: {
        cursor: { epoch: 'epoch', seq: 1 },
        entity: 'core.task',
        rowId: 'task-1',
        op: 'update',
        changedAt: '2026-07-15T00:00:00.000Z',
      },
    });
    await batchApplied;
    expect((await client.status()).cursor).toEqual({ epoch: 'epoch', seq: 1 });
    expect(pulledFrom).toEqual([{ epoch: 'epoch', seq: 0 }]);
    expect(await intents.list()).toEqual([]);
    expect(await intents.overlayMutations()).toEqual([]);
    expect(invalidations).toContainEqual({
      shapeId: 'shape',
      entity: 'core.task',
      rowId: 'task-1',
      source: 'overlay',
      intentId: 'intent-1',
      intentState: 'executed',
    });

    await replica.purge();
    expect(feed.listener).toBeUndefined();
    expect(worker.terminated).toBe(true);
    expect(await intents.list()).toEqual([]);
  });

  test('retries a failed pull without requiring another feed cursor event', async () => {
    const worker = new StateWorker();
    let applied!: () => void;
    const batchApplied = new Promise<void>((resolve) => (applied = resolve));
    worker.onApply = applied;
    const { client } = await ReplicaWorkerClient.connect(
      { dbName: '/centraid-replica-retry.sqlite3', vaultId: 'vault', remember: false },
      () => worker,
    );
    const feed = createFeed();
    let attempts = 0;
    const replica = new ReplicaCoordinator(client, new IntentQueue(new MemoryIntentStore()), {
      changeFeed: feed,
      feedRetryDelayMs: 0,
      pullChanges: async (cursor) => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary network failure');
        return {
          protocolVersion: 1,
          schemaEpoch: 'schema',
          from: cursor,
          to: { epoch: 'epoch', seq: 1 },
          changes: [],
        };
      },
    });
    await replica.bootstrap(snapshot);

    feed.emit({ type: 'centraid:vault-cursor', cursor: { epoch: 'epoch', seq: 1 } });

    await batchApplied;
    expect(attempts).toBe(2);
    expect((await client.status()).cursor).toEqual({ epoch: 'epoch', seq: 1 });
    await replica.close();
  });

  test('turns pull rebootstrap errors into one clean feed generation reset', async () => {
    const worker = new StateWorker();
    const { client } = await ReplicaWorkerClient.connect(
      { dbName: '/centraid-replica-generation.sqlite3', vaultId: 'vault', remember: false },
      () => worker,
    );
    const feed = createFeed();
    let required!: () => void;
    const rebootstrapRequired = new Promise<void>((resolve) => (required = resolve));
    let pulls = 0;
    const replica = new ReplicaCoordinator(client, new IntentQueue(new MemoryIntentStore()), {
      changeFeed: feed,
      feedRetryDelayMs: 0,
      pullChanges: async () => {
        pulls += 1;
        throw new ReplicaRebootstrapRequiredError('cursor-gap');
      },
      onRebootstrapRequired: required,
    });
    await replica.bootstrap(snapshot);
    feed.emit({ type: 'centraid:vault-cursor', cursor: { epoch: 'epoch', seq: 1 } });
    await rebootstrapRequired;
    expect((await client.status()).cursor).toBeNull();

    await replica.bootstrap({ ...snapshot, cursor: { epoch: 'new-epoch', seq: 0 } });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(pulls).toBe(1);
    expect((await client.status()).cursor).toEqual({ epoch: 'new-epoch', seq: 0 });
    await replica.close();
  });

  test('reconciles durable bootstrap outcomes before exposing the snapshot cursor', async () => {
    const worker = new StateWorker();
    const { client } = await ReplicaWorkerClient.connect(
      { dbName: '/centraid-replica-deadbeef.sqlite3', vaultId: 'vault', remember: false },
      () => worker,
    );
    const intents = new IntentQueue(new MemoryIntentStore(), { idFactory: () => 'persisted' });
    const replica = new ReplicaCoordinator(client, intents);
    await replica.enqueue({
      appId: 'agenda',
      action: 'create',
      input: { title: 'Offline' },
      optimistic: [
        {
          op: 'upsert',
          shapeId: 'shape',
          entity: 'core.task',
          rowId: 'task-1',
          values: { task_id: 'task-1', title: 'Offline' },
        },
      ],
    });
    await replica.bootstrap({
      ...snapshot,
      outcomes: [{ intentId: 'persisted', status: 'denied', reason: 'grant expired' }],
    });
    expect(await intents.list()).toEqual([]);
    expect(await intents.overlayMutations()).toEqual([]);
    await replica.close();
  });

  test('settles dependency-only intents individually without optimistic rows', async () => {
    const worker = new StateWorker();
    const { client } = await ReplicaWorkerClient.connect(
      { dbName: '/centraid-replica-settlement.sqlite3', vaultId: 'vault', remember: false },
      () => worker,
    );
    const replica = new ReplicaCoordinator(client, new IntentQueue(new MemoryIntentStore()));
    const invalidations: unknown[] = [];
    replica.subscribeInvalidations((items) => invalidations.push(...items));
    for (const intentId of ['first', 'second']) {
      await replica.enqueue({
        intentId,
        appId: 'agenda',
        action: 'cancel',
        input: { eventId: 'event-1' },
        dependencies: [{ shapeId: 'shape', entity: 'core.event' }],
      });
    }
    await replica.applyIntentOutcome({ intentId: 'first', status: 'denied' });
    await replica.applyIntentOutcome({ intentId: 'second', status: 'executed' });

    expect(invalidations).toContainEqual({
      shapeId: 'shape',
      entity: 'core.event',
      source: 'overlay',
      intentId: 'first',
      intentState: 'denied',
    });
    expect(invalidations).toContainEqual({
      shapeId: 'shape',
      entity: 'core.event',
      source: 'overlay',
      intentId: 'second',
      intentState: 'executed',
    });
    await replica.close();
  });

  test('drops an in-flight stale feed batch after a bootstrap generation reset', async () => {
    const worker = new StateWorker();
    const { client } = await ReplicaWorkerClient.connect(
      { dbName: '/centraid-replica-feed-race.sqlite3', vaultId: 'vault', remember: false },
      () => worker,
    );
    const feed = createFeed();
    let release!: (batch: ReplicaChangeBatch) => void;
    const pending = new Promise<ReplicaChangeBatch>((resolve) => (release = resolve));
    const replica = new ReplicaCoordinator(client, new IntentQueue(new MemoryIntentStore()), {
      changeFeed: feed,
      pullChanges: () => pending,
    });
    await replica.bootstrap(snapshot);
    feed.emit({ type: 'centraid:vault-cursor', cursor: { epoch: 'epoch', seq: 1 } });
    await vi.waitFor(() =>
      expect(worker.requests.some((request) => request.op === 'status')).toBe(true),
    );
    await replica.bootstrap({ ...snapshot, cursor: { epoch: 'new-epoch', seq: 0 } });
    release({
      protocolVersion: 1,
      schemaEpoch: 'schema',
      from: { epoch: 'epoch', seq: 0 },
      to: { epoch: 'epoch', seq: 1 },
      changes: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((await client.status()).cursor).toEqual({ epoch: 'new-epoch', seq: 0 });
    expect(worker.requests.filter((request) => request.op === 'apply-changes')).toHaveLength(0);
    await replica.close();
  });

  test('breaks a repeated non-progressing feed loop with one rebootstrap', async () => {
    const worker = new StateWorker();
    const { client } = await ReplicaWorkerClient.connect(
      { dbName: '/centraid-replica-feed-stuck.sqlite3', vaultId: 'vault', remember: false },
      () => worker,
    );
    const feed = createFeed();
    const onRebootstrapRequired = vi.fn();
    const pullChanges = vi.fn(
      async (cursor: ReplicaCursor): Promise<ReplicaChangeBatch> => ({
        protocolVersion: 1,
        schemaEpoch: 'schema',
        from: cursor,
        to: cursor,
        changes: [],
      }),
    );
    const replica = new ReplicaCoordinator(client, new IntentQueue(new MemoryIntentStore()), {
      changeFeed: feed,
      pullChanges,
      feedRetryDelayMs: 1,
      onRebootstrapRequired,
    });
    await replica.bootstrap(snapshot);

    feed.emit({ type: 'centraid:vault-cursor', cursor: { epoch: 'epoch', seq: 1 } });
    await vi.waitFor(() => expect(onRebootstrapRequired).toHaveBeenCalledTimes(1));

    expect(pullChanges).toHaveBeenCalledTimes(3);
    expect((await client.status()).cursor).toBeNull();
    await replica.close();
  });
});
