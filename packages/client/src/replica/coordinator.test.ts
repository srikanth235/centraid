// governance: allow-repo-hygiene file-size-limit cohesive coordinator regression suite; splitting would obscure issue #417 review
import { describe, expect, test, vi } from "vitest";

import { flushMacrotasks } from "@centraid/test-kit/flush";

import type { VaultChangeMessage } from "../vault-change-feed.js";
import { createReplicaCoordinator } from "./coordinator-web.js";
import { ReplicaCoordinator } from "./coordinator.js";
import type {
  ReplicaChangeFeedAdapter,
  ReplicaChangePuller,
  ReplicaCoordinatorOptions,
} from "./coordinator.js";
import { OnlineOnlyGuard, ReplicaRebootstrapRequiredError } from "./errors.js";
import { MemoryIntentStore } from "./intent-store.js";
import { IntentQueue } from "./intents.js";
import { NodeSqliteDriver } from "./node-sqlite-test-driver.js";
import { guardReplicaRow } from "./query.js";
import { ReplicaSqliteStore } from "./store-core.js";
import type { ReplicaStore } from "./store.js";
import type {
  ApplyChangesResult,
  OptimisticMutation,
  ReplicaBootstrapHeader,
  ReplicaChangeBatch,
  ReplicaCursor,
  ReplicaReadRequest,
  ReplicaReadResult,
  ReplicaReadWireResult,
  ReplicaSearchRequest,
  ReplicaSearchWireResult,
  ReplicaSnapshot,
  ReplicaSnapshotRow,
  ReplicaStatus,
} from "./types.js";
import { ReplicaWorkerClient } from "./worker-client.js";
import type { ReplicaWorkerLike } from "./worker-client.js";
import type {
  ReplicaWorkerRequest,
  ReplicaWorkerResponse,
} from "./worker-protocol.js";

interface TestFeed extends ReplicaChangeFeedAdapter {
  readonly listener: ((message: VaultChangeMessage) => void) | undefined;
  readonly resumed: ReplicaCursor | undefined;
  emit: (message: VaultChangeMessage) => void;
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
  readonly #messages = new Set<
    (event: MessageEvent<ReplicaWorkerResponse>) => void
  >();
  readonly #errors = new Set<(event: ErrorEvent) => void>();

  postMessage(request: ReplicaWorkerRequest): void {
    this.requests.push(request);
    let result: unknown;
    if (request.op === "open" || request.op === "status") {
      result = {
        mode: "memory",
        cursor: this.cursor,
        schemaEpoch: this.cursor ? "schema" : null,
      };
    } else if (request.op === "catalog") {
      result = [];
    } else if (request.op === "bootstrap") {
      this.cursor = request.payload.cursor;
      result = this.cursor;
    } else if (request.op === "apply-changes") {
      this.cursor = request.payload.to;
      this.onApply?.();
      result = {
        cursor: this.cursor,
        invalidations: request.payload.changes.map((change) => ({
          shapeId: change.shapeId,
          entity: change.entity,
          rowId: change.rowId,
          source: "canonical",
        })),
        outcomes: request.payload.outcomes ?? [],
      };
    } else if (request.op === "wipe") {
      this.cursor = null;
    } else if (request.op === "search") {
      result = {
        cursor: this.cursor,
        dependency: {
          shapeId: request.payload.request.shapeId,
          entity: request.payload.request.entity,
        },
        rows: [],
      };
    }
    const response: ReplicaWorkerResponse = {
      id: request.id,
      ok: true,
      result,
    };
    queueMicrotask(() => {
      const event = new MessageEvent<ReplicaWorkerResponse>("message", {
        data: response,
      });
      for (const listener of this.#messages) listener(event);
    });
  }

  addEventListener(
    type: "message" | "error",
    listener:
      | ((event: MessageEvent<ReplicaWorkerResponse>) => void)
      | ((event: ErrorEvent) => void)
  ): void {
    if (type === "message") {
      this.#messages.add(
        listener as (event: MessageEvent<ReplicaWorkerResponse>) => void
      );
    } else {
      this.#errors.add(listener as (event: ErrorEvent) => void);
    }
  }

  removeEventListener(
    type: "message" | "error",
    listener:
      | ((event: MessageEvent<ReplicaWorkerResponse>) => void)
      | ((event: ErrorEvent) => void)
  ): void {
    if (type === "message") {
      this.#messages.delete(
        listener as (event: MessageEvent<ReplicaWorkerResponse>) => void
      );
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
  vaultId: "vault",
  schemaEpoch: "schema",
  cursor: { epoch: "epoch", seq: 0 },
  shapes: [],
  rows: [],
};

describe(ReplicaCoordinator, () => {
  test("captures canonical row versions and refreshes them atomically on retry", async () => {
    const store = promisedStore(
      new ReplicaSqliteStore(new NodeSqliteDriver(), "vault-a", "memory")
    );
    const intentIds = ["intent-original", "intent-retry"];
    const intents = new IntentQueue(new MemoryIntentStore(), {
      idFactory: () => intentIds.shift()!,
    });
    const replica = new ReplicaCoordinator(store, intents);
    await replica.bootstrap({
      ...windowedHeader(),
      cursor: { epoch: "epoch-1", seq: 4 },
      rows: [
        {
          shapeId: "shape-agenda",
          entity: "core.event",
          rowId: "event-1",
          values: { id: "event-1", title: "Canonical" },
          rowVersion: 4,
        },
      ],
    });
    const optimistic: OptimisticMutation[] = [
      {
        op: "upsert",
        shapeId: "shape-agenda",
        entity: "core.event",
        rowId: "event-1",
        values: { id: "event-1", title: "Offline" },
      },
    ];

    await expect(
      replica.captureBaseVersions(optimistic)
    ).resolves.toStrictEqual([
      {
        shapeId: "shape-agenda",
        entity: "core.event",
        rowId: "event-1",
        version: 4,
      },
    ]);
    await replica.enqueue({
      appId: "agenda",
      action: "unknown-edit",
      input: { event_id: "event-1", title: "Offline" },
      optimistic,
      baseVersions: [
        {
          shapeId: "shape-agenda",
          entity: "core.event",
          rowId: "event-1",
          version: 3,
        },
      ],
    });
    await replica.claimNextIntent();
    await replica.applyIntentOutcome({
      intentId: "intent-original",
      status: "conflict",
      conflict: {
        shapeId: "shape-agenda",
        entity: "core.event",
        rowId: "event-1",
        expectedVersion: 3,
        actualVersion: 4,
      },
    });

    await expect(replica.retryIntent("intent-original")).resolves.toMatchObject(
      {
        intentId: "intent-retry",
        state: "queued",
        baseVersions: [{ rowId: "event-1", version: 4 }],
      }
    );
    await expect(intents.list()).resolves.toMatchObject([
      { intentId: "intent-retry", state: "queued" },
    ]);
    await expect(intents.listSettled()).resolves.toMatchObject([
      { intentId: "intent-original", status: "conflict" },
    ]);
    await replica.close();
  });

  test("uses an in-memory outbox when requested persistence falls back to memory", async () => {
    const worker = new StateWorker();
    const indexedDbFactory = {
      open: vi.fn<IDBFactory["open"]>(() => {
        throw new Error("memory fallback must not open IndexedDB");
      }),
    } as unknown as IDBFactory;
    const { replica, status } = await createReplicaCoordinator(
      { gatewayId: "gateway", vaultId: "vault" },
      true,
      {
        workerFactory: () => worker,
        indexedDbFactory,
        idFactory: () => "memory-intent",
      }
    );

    expect(status.mode).toBe("memory");
    await replica.enqueue({
      appId: "agenda",
      action: "create",
      input: { title: "Local" },
    });
    expect(indexedDbFactory.open).not.toHaveBeenCalled();
    await replica.purge();
  });

  test("applies the pending intent overlay to local searches", async () => {
    const worker = new StateWorker();
    const { client } = await ReplicaWorkerClient.connect(
      {
        dbName: "/centraid-replica-search.sqlite3",
        vaultId: "vault",
        remember: false,
      },
      () => worker
    );
    const replica = new ReplicaCoordinator(
      client,
      new IntentQueue(new MemoryIntentStore(), {
        idFactory: () => "search-intent",
      })
    );
    await replica.bootstrap(snapshot);
    await replica.enqueue({
      appId: "agenda",
      action: "rename",
      input: { eventId: "event-1" },
      optimistic: [
        {
          op: "upsert",
          shapeId: "shape-agenda",
          entity: "core.event",
          rowId: "event-1",
          values: { summary: "Offline planning" },
        },
      ],
    });

    await replica.searchWire({
      shapeId: "shape-agenda",
      entity: "core.event",
      query: "offline",
    });

    expect(worker.requests.at(-1)).toMatchObject({
      op: "search",
      payload: {
        request: {
          shapeId: "shape-agenda",
          entity: "core.event",
          query: "offline",
        },
        mutations: [
          {
            op: "upsert",
            shapeId: "shape-agenda",
            entity: "core.event",
            rowId: "event-1",
            values: { summary: "Offline planning" },
          },
        ],
      },
    });
    await replica.close();
  });

  test("resumes a warm OPFS cursor before attaching the shared feed", async () => {
    const worker = new StateWorker();
    worker.cursor = { epoch: "warm", seq: 42 };
    const events: string[] = [];
    const feed: ReplicaChangeFeedAdapter = {
      async setShapeIds(shapeIds) {
        events.push(`shapes:${shapeIds.join(",")}`);
      },
      async resume(cursor) {
        events.push(`resume:${cursor.epoch}:${cursor.seq}`);
      },
      subscribe() {
        events.push("subscribe");
        return () => undefined;
      },
    };
    const { replica, status } = await createReplicaCoordinator(
      { gatewayId: "gateway", vaultId: "vault" },
      true,
      {
        workerFactory: () => worker,
        intentStore: new MemoryIntentStore(),
        changeFeed: feed,
        pullChanges: async () => undefined,
      }
    );
    expect(status.cursor).toStrictEqual({ epoch: "warm", seq: 42 });
    expect(events).toStrictEqual(["shapes:", "resume:warm:42", "subscribe"]);
    await replica.close();
  });

  test("uses the shared feed as a pull trigger and resolves overlays before cursor advance", async () => {
    const worker = new StateWorker();
    let applied!: () => void;
    const batchApplied = new Promise<void>((resolve) => {
      applied = resolve;
    });
    worker.onApply = applied;
    const { client } = await ReplicaWorkerClient.connect(
      {
        dbName: "/centraid-replica-deadbeef.sqlite3",
        vaultId: "vault",
        remember: false,
      },
      () => worker
    );
    const store = new MemoryIntentStore();
    const intents = new IntentQueue(store, { idFactory: () => "intent-1" });
    const feed = createFeed();
    const pulledFrom: ReplicaCursor[] = [];
    const invalidations: unknown[] = [];
    const replica = new ReplicaCoordinator(client, intents, {
      changeFeed: feed,
      pullChanges: async (cursor) => {
        pulledFrom.push(cursor);
        return {
          protocolVersion: 1,
          schemaEpoch: "schema",
          from: cursor,
          to: { epoch: "epoch", seq: 1 },
          changes: [
            {
              op: "upsert",
              shapeId: "shape",
              entity: "core.task",
              rowId: "task-1",
              values: { task_id: "task-1", status: "done" },
            },
          ],
          outcomes: [{ intentId: "intent-1", status: "executed" }],
        };
      },
    });
    replica.subscribeInvalidations((items) => invalidations.push(...items));
    await replica.bootstrap(snapshot);
    expect(feed.resumed).toStrictEqual({ epoch: "epoch", seq: 0 });

    await replica.enqueue({
      appId: "agenda",
      action: "complete",
      input: { taskId: "task-1" },
      optimistic: [
        {
          op: "upsert",
          shapeId: "shape",
          entity: "core.task",
          rowId: "task-1",
          values: { status: "done" },
        },
      ],
    });
    await replica.claimNextIntent();
    await replica.markIntentAwaitingChange("intent-1");
    feed.emit({
      type: "centraid:vault-change",
      detail: {
        cursor: { epoch: "epoch", seq: 1 },
        entity: "core.task",
        rowId: "task-1",
        op: "update",
        changedAt: "2026-07-15T00:00:00.000Z",
      },
    });
    await batchApplied;
    expect((await client.status()).cursor).toStrictEqual({
      epoch: "epoch",
      seq: 1,
    });
    expect(pulledFrom).toStrictEqual([{ epoch: "epoch", seq: 0 }]);
    await expect(intents.list()).resolves.toStrictEqual([]);
    await expect(intents.overlayMutations()).resolves.toStrictEqual([]);
    expect(invalidations).toContainEqual({
      shapeId: "shape",
      entity: "core.task",
      rowId: "task-1",
      source: "overlay",
      intentId: "intent-1",
      intentState: "executed",
    });

    await replica.purge();
    expect(feed.listener).toBeUndefined();
    expect(worker.terminated).toBe(true);
    await expect(intents.list()).resolves.toStrictEqual([]);
  });

  test("retries a failed pull without requiring another feed cursor event", async () => {
    const worker = new StateWorker();
    let applied!: () => void;
    const batchApplied = new Promise<void>((resolve) => {
      applied = resolve;
    });
    worker.onApply = applied;
    const { client } = await ReplicaWorkerClient.connect(
      {
        dbName: "/centraid-replica-retry.sqlite3",
        vaultId: "vault",
        remember: false,
      },
      () => worker
    );
    const feed = createFeed();
    let attempts = 0;
    const replica = new ReplicaCoordinator(
      client,
      new IntentQueue(new MemoryIntentStore()),
      {
        changeFeed: feed,
        feedRetryDelayMs: 0,
        pullChanges: async (cursor) => {
          attempts += 1;
          if (attempts === 1) throw new Error("temporary network failure");
          return {
            protocolVersion: 1,
            schemaEpoch: "schema",
            from: cursor,
            to: { epoch: "epoch", seq: 1 },
            changes: [],
          };
        },
      }
    );
    await replica.bootstrap(snapshot);

    feed.emit({
      type: "centraid:vault-cursor",
      cursor: { epoch: "epoch", seq: 1 },
    });

    await batchApplied;
    expect(attempts).toBe(2);
    expect((await client.status()).cursor).toStrictEqual({
      epoch: "epoch",
      seq: 1,
    });
    await replica.close();
  });

  test("turns pull rebootstrap errors into one clean feed generation reset", async () => {
    const worker = new StateWorker();
    const { client } = await ReplicaWorkerClient.connect(
      {
        dbName: "/centraid-replica-generation.sqlite3",
        vaultId: "vault",
        remember: false,
      },
      () => worker
    );
    const feed = createFeed();
    let required!: () => void;
    const rebootstrapRequired = new Promise<void>((resolve) => {
      required = resolve;
    });
    let pulls = 0;
    const replica = new ReplicaCoordinator(
      client,
      new IntentQueue(new MemoryIntentStore()),
      {
        changeFeed: feed,
        feedRetryDelayMs: 0,
        pullChanges: async () => {
          pulls += 1;
          throw new ReplicaRebootstrapRequiredError("cursor-gap");
        },
        onRebootstrapRequired: required,
      }
    );
    await replica.bootstrap(snapshot);
    feed.emit({
      type: "centraid:vault-cursor",
      cursor: { epoch: "epoch", seq: 1 },
    });
    await rebootstrapRequired;
    expect((await client.status()).cursor).toBeNull();

    await replica.bootstrap({
      ...snapshot,
      cursor: { epoch: "new-epoch", seq: 0 },
    });
    await vi.waitFor(() => {
      expect(pulls).toBe(1);
    });
    expect((await client.status()).cursor).toStrictEqual({
      epoch: "new-epoch",
      seq: 0,
    });
    await replica.close();
  });

  test("reconciles durable bootstrap outcomes before exposing the snapshot cursor", async () => {
    const worker = new StateWorker();
    const { client } = await ReplicaWorkerClient.connect(
      {
        dbName: "/centraid-replica-deadbeef.sqlite3",
        vaultId: "vault",
        remember: false,
      },
      () => worker
    );
    const intents = new IntentQueue(new MemoryIntentStore(), {
      idFactory: () => "persisted",
    });
    const replica = new ReplicaCoordinator(client, intents);
    await replica.enqueue({
      appId: "agenda",
      action: "create",
      input: { title: "Offline" },
      optimistic: [
        {
          op: "upsert",
          shapeId: "shape",
          entity: "core.task",
          rowId: "task-1",
          values: { task_id: "task-1", title: "Offline" },
        },
      ],
    });
    await replica.bootstrap({
      ...snapshot,
      outcomes: [
        { intentId: "persisted", status: "denied", reason: "grant expired" },
      ],
    });
    await expect(intents.list()).resolves.toMatchObject([
      { intentId: "persisted", state: "denied", reason: "grant expired" },
    ]);
    await expect(intents.overlayMutations()).resolves.toMatchObject([
      {
        rowId: "task-1",
        values: {
          __centraid_pending_key: "persisted",
          __centraid_pending_status: "denied",
          __centraid_pending_reason: "grant expired",
        },
      },
    ]);
    await replica.close();
  });

  test("settles dependency-only intents individually without optimistic rows", async () => {
    const worker = new StateWorker();
    const { client } = await ReplicaWorkerClient.connect(
      {
        dbName: "/centraid-replica-settlement.sqlite3",
        vaultId: "vault",
        remember: false,
      },
      () => worker
    );
    const replica = new ReplicaCoordinator(
      client,
      new IntentQueue(new MemoryIntentStore())
    );
    const invalidations: unknown[] = [];
    replica.subscribeInvalidations((items) => invalidations.push(...items));
    const enqueueNext = async (index: number): Promise<void> => {
      const intentId = ["first", "second"][index];
      if (!intentId) return;
      await replica.enqueue({
        intentId,
        appId: "agenda",
        action: "cancel",
        input: { eventId: "event-1" },
        dependencies: [{ shapeId: "shape", entity: "core.event" }],
      });
      return enqueueNext(index + 1);
    };
    await enqueueNext(0);
    await replica.applyIntentOutcome({ intentId: "first", status: "denied" });
    await replica.applyIntentOutcome({
      intentId: "second",
      status: "executed",
    });

    expect(invalidations).toContainEqual({
      shapeId: "shape",
      entity: "core.event",
      source: "overlay",
      intentId: "first",
      intentState: "denied",
    });
    expect(invalidations).toContainEqual({
      shapeId: "shape",
      entity: "core.event",
      source: "overlay",
      intentId: "second",
      intentState: "executed",
    });
    await replica.close();
  });

  test("drops an in-flight stale feed batch after a bootstrap generation reset", async () => {
    const worker = new StateWorker();
    const { client } = await ReplicaWorkerClient.connect(
      {
        dbName: "/centraid-replica-feed-race.sqlite3",
        vaultId: "vault",
        remember: false,
      },
      () => worker
    );
    const feed = createFeed();
    let release!: (batch: ReplicaChangeBatch) => void;
    const pending = new Promise<ReplicaChangeBatch>((resolve) => {
      release = resolve;
    });
    const replica = new ReplicaCoordinator(
      client,
      new IntentQueue(new MemoryIntentStore()),
      {
        changeFeed: feed,
        pullChanges: () => pending,
      }
    );
    await replica.bootstrap(snapshot);
    feed.emit({
      type: "centraid:vault-cursor",
      cursor: { epoch: "epoch", seq: 1 },
    });
    await vi.waitFor(() =>
      expect(worker.requests.some((request) => request.op === "status")).toBe(
        true
      )
    );
    await replica.bootstrap({
      ...snapshot,
      cursor: { epoch: "new-epoch", seq: 0 },
    });
    release({
      protocolVersion: 1,
      schemaEpoch: "schema",
      from: { epoch: "epoch", seq: 0 },
      to: { epoch: "epoch", seq: 1 },
      changes: [],
    });
    await flushMacrotasks();

    expect((await client.status()).cursor).toStrictEqual({
      epoch: "new-epoch",
      seq: 0,
    });
    expect(
      worker.requests.filter((request) => request.op === "apply-changes")
    ).toHaveLength(0);
    await replica.close();
  });

  test("breaks a repeated non-progressing feed loop with one rebootstrap", async () => {
    const worker = new StateWorker();
    const { client } = await ReplicaWorkerClient.connect(
      {
        dbName: "/centraid-replica-feed-stuck.sqlite3",
        vaultId: "vault",
        remember: false,
      },
      () => worker
    );
    const feed = createFeed();
    const onRebootstrapRequired =
      vi.fn<NonNullable<ReplicaCoordinatorOptions["onRebootstrapRequired"]>>();
    const pullChanges = vi.fn<ReplicaChangePuller>(
      async (cursor): Promise<ReplicaChangeBatch> => ({
        protocolVersion: 1,
        schemaEpoch: "schema",
        from: cursor,
        to: cursor,
        changes: [],
      })
    );
    const replica = new ReplicaCoordinator(
      client,
      new IntentQueue(new MemoryIntentStore()),
      {
        changeFeed: feed,
        pullChanges,
        feedRetryDelayMs: 1,
        onRebootstrapRequired,
      }
    );
    await replica.bootstrap(snapshot);

    feed.emit({
      type: "centraid:vault-cursor",
      cursor: { epoch: "epoch", seq: 1 },
    });
    await vi.waitFor(() =>
      expect(onRebootstrapRequired).toHaveBeenCalledOnce()
    );

    expect(pullChanges).toHaveBeenCalledTimes(3);
    expect((await client.status()).cursor).toBeNull();
    await replica.close();
  });

  test("a bootstrapped replica survives a change-stream pull disconnect without wipe", async () => {
    const worker = new StateWorker();
    const { client } = await ReplicaWorkerClient.connect(
      {
        dbName: "/centraid-replica-feed-disconnect.sqlite3",
        vaultId: "vault",
        remember: false,
      },
      () => worker
    );
    const feed = createFeed();
    const onRebootstrapRequired =
      vi.fn<NonNullable<ReplicaCoordinatorOptions["onRebootstrapRequired"]>>();
    const replica = new ReplicaCoordinator(
      client,
      new IntentQueue(new MemoryIntentStore()),
      {
        changeFeed: feed,
        feedRetryDelayMs: 0,
        pullChanges: async () => {
          throw new Error("Failed to fetch");
        },
        onRebootstrapRequired,
      }
    );
    await replica.bootstrap(snapshot);

    feed.emit({
      type: "centraid:vault-cursor",
      cursor: { epoch: "epoch", seq: 1 },
    });
    await flushMacrotasks();
    await flushMacrotasks();

    expect(onRebootstrapRequired).not.toHaveBeenCalled();
    expect((await client.status()).cursor).toStrictEqual({
      epoch: "epoch",
      seq: 0,
    });
    await replica.close();
  });

  test("a sentinel rebootstrap frame resumes the feed instead of wiping", async () => {
    const worker = new StateWorker();
    const { client } = await ReplicaWorkerClient.connect(
      {
        dbName: "/centraid-replica-sentinel-rebootstrap.sqlite3",
        vaultId: "vault",
        remember: false,
      },
      () => worker
    );
    const feed = createFeed();
    const onRebootstrapRequired =
      vi.fn<NonNullable<ReplicaCoordinatorOptions["onRebootstrapRequired"]>>();
    const replica = new ReplicaCoordinator(
      client,
      new IntentQueue(new MemoryIntentStore()),
      {
        changeFeed: feed,
        pullChanges: async () => undefined,
        onRebootstrapRequired,
      }
    );
    await replica.bootstrap(snapshot);
    expect(feed.resumed).toStrictEqual({ epoch: "epoch", seq: 0 });

    feed.emit({
      type: "centraid:vault-rebootstrap",
      detail: { error: "replica_rebootstrap_required", reason: "initial" },
    });
    await flushMacrotasks();

    expect(onRebootstrapRequired).not.toHaveBeenCalled();
    expect((await client.status()).cursor).toStrictEqual({
      epoch: "epoch",
      seq: 0,
    });
    expect(feed.resumed).toStrictEqual({ epoch: "epoch", seq: 0 });
    await replica.close();
  });

  /**
   * Boot regression: the gateway answers a not-yet-bootstrapped replica with a
   * `rebootstrap` frame, which lands while the shell is already walking a
   * windowed bootstrap. Wiping the store there deletes
   * `replica_bootstrap_progress` between two pages, and the walk then dies with
   * "No replica bootstrap is open" — a bootstrap killed by the very demand it
   * was already satisfying.
   */
  test("a feed rebootstrap demand does not wipe an open windowed bootstrap", async () => {
    const store = promisedStore(
      new ReplicaSqliteStore(new NodeSqliteDriver(), "vault-a", "memory")
    );
    const feed = createFeed();
    const onRebootstrapRequired = vi.fn<(detail: unknown) => void>();
    const replica = new ReplicaCoordinator(
      store,
      new IntentQueue(new MemoryIntentStore()),
      {
        changeFeed: feed,
        pullChanges: async () => {
          throw new Error("the walk must not pull changes");
        },
        onRebootstrapRequired,
      }
    );
    const header = windowedHeader();

    await replica.bootstrapBegin(header);
    feed.emit({
      type: "centraid:vault-rebootstrap",
      detail: { reason: "schema-mismatch" },
    });
    await flushMacrotasks();

    // The walk must still own the store.
    await replica.bootstrapPage([]);
    const cursor: ReplicaCursor = { epoch: "replica-1", seq: 2 };
    await expect(
      replica.bootstrapCommit(cursor, header)
    ).resolves.toStrictEqual(cursor);
    // …and the demand is honoured once the walk seals, not swallowed: the wipe
    // and the notification both land, just after the commit instead of under it.
    expect(onRebootstrapRequired).toHaveBeenCalledWith({
      reason: "schema-mismatch",
    });
    expect((await store.status()).cursor).toBeNull();
  });

  test("an initial sentinel during a windowed bootstrap does not wipe after commit", async () => {
    const store = promisedStore(
      new ReplicaSqliteStore(new NodeSqliteDriver(), "vault-a", "memory")
    );
    const feed = createFeed();
    const onRebootstrapRequired = vi.fn<(detail: unknown) => void>();
    const replica = new ReplicaCoordinator(
      store,
      new IntentQueue(new MemoryIntentStore()),
      {
        changeFeed: feed,
        pullChanges: async () => {
          throw new Error("the walk must not pull changes");
        },
        onRebootstrapRequired,
      }
    );
    const header = windowedHeader();
    const cursor: ReplicaCursor = { epoch: "replica-1", seq: 2 };

    await replica.bootstrapBegin(header);
    feed.emit({
      type: "centraid:vault-rebootstrap",
      detail: { error: "replica_rebootstrap_required", reason: "initial" },
    });
    await flushMacrotasks();
    await replica.bootstrapPage([]);
    await expect(
      replica.bootstrapCommit(cursor, header)
    ).resolves.toStrictEqual(cursor);

    expect(onRebootstrapRequired).not.toHaveBeenCalled();
    expect((await store.status()).cursor).toStrictEqual(cursor);
    await replica.close();
  });

  // `syncNow` is the pull-on-demand inverse of the push-driven feed above: a
  // caller that just finished a gateway-side write (Home's sample seed) awaits
  // it so its very next read sees the rows, instead of racing the SSE nudge.
  test("syncNow pulls to the gateway head without waiting for a feed nudge", async () => {
    const worker = new StateWorker();
    const { client } = await ReplicaWorkerClient.connect(
      {
        dbName: "/centraid-replica-sync-now.sqlite3",
        vaultId: "vault",
        remember: false,
      },
      () => worker
    );
    const pulledFrom: ReplicaCursor[] = [];
    const replica = new ReplicaCoordinator(
      client,
      new IntentQueue(new MemoryIntentStore()),
      {
        pullChanges: async (cursor): Promise<ReplicaChangeBatch> => {
          pulledFrom.push(cursor);
          // Two pages, then caught up: the loop must follow `hasMore` rather
          // than stopping at the first batch, or a seed bigger than one commit
          // group would still paint half-empty tiles.
          const seq = cursor.seq + 1;
          return {
            protocolVersion: 1,
            schemaEpoch: "schema",
            from: cursor,
            to: { epoch: "epoch", seq },
            changes: [],
            hasMore: seq < 2,
          };
        },
      }
    );
    await replica.bootstrap(snapshot);

    await replica.syncNow();

    expect(pulledFrom).toStrictEqual([
      { epoch: "epoch", seq: 0 },
      { epoch: "epoch", seq: 1 },
    ]);
    expect((await client.status()).cursor).toStrictEqual({
      epoch: "epoch",
      seq: 2,
    });
    await replica.close();
  });

  test("syncNow resolves without pulling before the first bootstrap", async () => {
    const worker = new StateWorker();
    const { client } = await ReplicaWorkerClient.connect(
      {
        dbName: "/centraid-replica-sync-cold.sqlite3",
        vaultId: "vault",
        remember: false,
      },
      () => worker
    );
    const pullChanges = vi.fn<ReplicaChangePuller>();
    const replica = new ReplicaCoordinator(
      client,
      new IntentQueue(new MemoryIntentStore()),
      { pullChanges }
    );

    // No cursor yet: the bootstrap walk owns the first fill, and pulling
    // changes from nowhere is a protocol error waiting to happen.
    await replica.syncNow();

    expect(pullChanges).not.toHaveBeenCalled();
    await replica.close();
  });

  test("syncNow stops cleanly when the gateway reports no progress", async () => {
    const worker = new StateWorker();
    const { client } = await ReplicaWorkerClient.connect(
      {
        dbName: "/centraid-replica-sync-flat.sqlite3",
        vaultId: "vault",
        remember: false,
      },
      () => worker
    );
    const replica = new ReplicaCoordinator(
      client,
      new IntentQueue(new MemoryIntentStore()),
      {
        pullChanges: async (cursor): Promise<ReplicaChangeBatch> => ({
          protocolVersion: 1,
          schemaEpoch: "schema",
          from: cursor,
          to: cursor,
          changes: [],
        }),
      }
    );
    await replica.bootstrap(snapshot);

    await replica.syncNow();

    // Nothing beyond the cursor: no batch is applied and no loop spins.
    expect(
      worker.requests.filter((request) => request.op === "apply-changes")
    ).toHaveLength(0);
    await replica.close();
  });
});

function windowedHeader(): ReplicaBootstrapHeader {
  return {
    protocolVersion: 1,
    vaultId: "vault-a",
    schemaEpoch: "schema-1",
    shapes: [
      {
        shapeId: "shape-agenda",
        appId: "agenda",
        purpose: "dpv:ServiceProvision",
        entities: [
          { entity: "core.event", primaryKey: "id", columns: ["id", "title"] },
        ],
      },
    ],
  };
}

/**
 * The synchronous store core behind the async `ReplicaStore` seam — the same
 * adapter shape the web worker and the native store fill. The coordinator under
 * test therefore drives a REAL replica, which is what makes "a bootstrap is
 * open" enforceable; a hand-rolled fake would have to restate the invariant it
 * is supposed to be proving.
 */
function promisedStore(core: ReplicaSqliteStore): ReplicaStore {
  return {
    status: () => Promise.resolve(core.status() as ReplicaStatus),
    catalog: () => Promise.resolve(core.catalog()),
    bootstrap: (full: ReplicaSnapshot) => Promise.resolve(core.bootstrap(full)),
    bootstrapBegin: (header: ReplicaBootstrapHeader) => {
      core.bootstrapBegin(header);
      return Promise.resolve(undefined);
    },
    bootstrapPage: (rows: ReplicaSnapshotRow[]) => {
      core.bootstrapPage(rows);
      return Promise.resolve(undefined);
    },
    bootstrapPreview: (cursor: ReplicaCursor) => {
      core.bootstrapPreview(cursor);
      return Promise.resolve(undefined);
    },
    bootstrapCommit: (cursor: ReplicaCursor) =>
      Promise.resolve(core.bootstrapCommit(cursor)),
    applyChanges: (batch: ReplicaChangeBatch): Promise<ApplyChangesResult> =>
      Promise.resolve(core.applyChanges(batch)),
    read: (
      request: ReplicaReadRequest,
      mutations: OptimisticMutation[] = []
    ): Promise<ReplicaReadResult> => {
      const result = core.read(request, mutations);
      const guard = new OnlineOnlyGuard();
      return Promise.resolve({
        rows: result.rows.map((row) => guardReplicaRow(row, guard)),
        receiptId: `replica:${result.cursor.epoch}:${result.cursor.seq}`,
        dependency: result.dependency,
        coverage: result.coverage,
      });
    },
    readWire: (
      request: ReplicaReadRequest,
      mutations: OptimisticMutation[] = []
    ): Promise<ReplicaReadWireResult> =>
      Promise.resolve(core.read(request, mutations)),
    searchWire: (
      request: ReplicaSearchRequest,
      mutations: OptimisticMutation[] = []
    ): Promise<ReplicaSearchWireResult> =>
      Promise.resolve(core.search(request, mutations)),
    wipe: () => {
      core.wipe();
      return Promise.resolve(undefined);
    },
    close: () => {
      core.close();
      return Promise.resolve();
    },
    purge: () => {
      core.wipe();
      core.close();
      return Promise.resolve();
    },
  };
}
