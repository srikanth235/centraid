import { describe, expect, test, vi } from "vitest";

import { MemoryIntentStore } from "./intent-store.js";
import { IntentQueue } from "./intents.js";

describe(IntentQueue, () => {
  test("uses injected digest and initializes optional collections", async () => {
    const queue = new IntentQueue(new MemoryIntentStore(), {
      idFactory: () => "intent-options",
      digest: async () => "injected-digest",
    });

    await expect(
      queue.enqueue({
        appId: "agenda",
        action: "create",
        input: { title: "A" },
      })
    ).resolves.toMatchObject({
      intentId: "intent-options",
      payloadHash: "injected-digest",
      optimistic: [],
      dependencies: [],
    });
  });

  test("retries with the same id and removes the overlay only after canonical outcome", async () => {
    const queue = new IntentQueue(new MemoryIntentStore(), {
      idFactory: () => "intent-1",
    });
    const enqueued = await queue.enqueue({
      appId: "agenda",
      action: "complete",
      input: { taskId: "task-1" },
      optimistic: [
        {
          op: "upsert",
          shapeId: "shape-agenda",
          entity: "core.task",
          rowId: "task-1",
          values: { status: "done" },
        },
      ],
    });
    expect(enqueued).toMatchObject({
      intentId: "intent-1",
      state: "queued",
      attempts: 0,
    });
    expect(enqueued.payloadHash).toMatch(/^[a-f0-9]{64}$/u);

    await expect(queue.claimNext()).resolves.toMatchObject({
      state: "sending",
      attempts: 1,
    });
    await queue.transportFailed("intent-1", "offline");
    await expect(queue.claimNext()).resolves.toMatchObject({
      intentId: "intent-1",
      state: "sending",
      attempts: 2,
    });
    await queue.awaitingChange("intent-1");
    await expect(queue.overlayMutations()).resolves.toHaveLength(1);

    const [settled] = await queue.applyOutcomes([
      { intentId: "intent-1", status: "executed" },
    ]);
    await expect(queue.overlayMutations()).resolves.toStrictEqual([]);
    expect(settled).toMatchObject({
      intentId: "intent-1",
      state: "executed",
      attempts: 2,
    });
    await expect(queue.list()).resolves.toStrictEqual([]);
  });

  test("parked overlays survive reload-length waits while denial rolls them back", async () => {
    const store = new MemoryIntentStore();
    const queue = new IntentQueue(store, { idFactory: () => "intent-parked" });
    await queue.enqueue({
      appId: "notes",
      action: "share",
      input: { noteId: "note-1" },
      optimistic: [
        {
          op: "upsert",
          shapeId: "shape-notes",
          entity: "knowledge.note",
          rowId: "note-1",
          values: { share_state: "pending" },
        },
      ],
    });
    await queue.claimNext();
    await queue.applyOutcomes([
      {
        intentId: "intent-parked",
        status: "parked",
        reason: "confirmation required",
      },
    ]);
    await expect(queue.overlayMutations()).resolves.toHaveLength(1);
    expect((await queue.pending())[0]).toMatchObject({
      state: "parked",
      reason: "confirmation required",
    });

    const [denied] = await queue.applyOutcomes([
      { intentId: "intent-parked", status: "denied", reason: "owner denied" },
    ]);
    await expect(queue.overlayMutations()).resolves.toStrictEqual([]);
    expect(denied).toMatchObject({ state: "denied", reason: "owner denied" });
    await expect(queue.list()).resolves.toStrictEqual([]);
  });

  test("explicit intent ids dedupe equal payloads and reject tampered reuse", async () => {
    const queue = new IntentQueue(new MemoryIntentStore());
    const first = await queue.enqueue({
      intentId: "stable-id",
      appId: "agenda",
      action: "create",
      input: { title: "First" },
    });
    const replay = await queue.enqueue({
      intentId: "stable-id",
      appId: "agenda",
      action: "create",
      input: { title: "First" },
    });
    expect(replay).toStrictEqual(first);
    await expect(queue.list()).resolves.toHaveLength(1);
    await expect(
      queue.enqueue({
        intentId: "stable-id",
        appId: "agenda",
        action: "create",
        input: { title: "Different retry payload" },
      })
    ).rejects.toThrow("reused with another payload");
  });

  test("requeues a sending intent after a renderer reload without changing its identity", async () => {
    const store = new MemoryIntentStore();
    const first = new IntentQueue(store, { idFactory: () => "intent-reload" });
    const queued = await first.enqueue({
      appId: "agenda",
      action: "create",
      input: { title: "A" },
    });
    await first.claimNext();

    const recovered = new IntentQueue(store);
    await expect(recovered.recoverSending()).resolves.toStrictEqual([
      expect.objectContaining({
        intentId: queued.intentId,
        payloadHash: queued.payloadHash,
        state: "queued",
        attempts: 1,
        reason: "recovered after reload",
      }),
    ]);
    await expect(recovered.claimNext()).resolves.toMatchObject({
      intentId: "intent-reload",
      payloadHash: queued.payloadHash,
      state: "sending",
      attempts: 2,
    });
  });

  test("retains structured terminal conflicts after scrubbing the queued input", async () => {
    const queue = new IntentQueue(new MemoryIntentStore(), {
      idFactory: () => "intent-conflict",
    });
    await queue.enqueue({
      appId: "agenda",
      action: "edit",
      input: { title: "offline" },
    });
    await queue.claimNext();
    const conflict = {
      shapeId: "shape-agenda",
      entity: "core.event",
      rowId: "event-1",
      expectedVersion: 4,
      actualVersion: 5,
    };
    const [settled] = await queue.applyOutcomes([
      {
        intentId: "intent-conflict",
        status: "conflict",
        reason: "canonical row changed",
        conflict,
      },
    ]);

    expect(settled).toMatchObject({ state: "failed" });
    await expect(queue.list()).resolves.toStrictEqual([]);
    await expect(queue.overlayMutations()).resolves.toStrictEqual([]);
    await expect(queue.listSettled()).resolves.toMatchObject([
      {
        intentId: "intent-conflict",
        status: "conflict",
        conflict,
      },
    ]);
  });

  test("returns a settled transition with an explicit awaiting-change reason reset", async () => {
    const queue = new IntentQueue(new MemoryIntentStore(), {
      idFactory: () => "intent-awaiting-change",
    });
    await queue.enqueue({
      appId: "agenda",
      action: "create",
      input: { title: "A" },
    });
    await queue.claimNext();

    await expect(
      queue.awaitingChange("intent-awaiting-change")
    ).resolves.toMatchObject({
      state: "awaiting-change",
      reason: undefined,
    });
  });

  test("ignores outcomes for intents no longer present", async () => {
    const queue = new IntentQueue(new MemoryIntentStore());

    await expect(
      queue.applyOutcomes([{ intentId: "already-purged", status: "executed" }])
    ).resolves.toStrictEqual([]);
    await expect(queue.list()).resolves.toStrictEqual([]);
  });

  test("applies optimistic overlay filters independently", async () => {
    const queue = new IntentQueue(new MemoryIntentStore(), {
      idFactory: () => "intent-filters",
    });
    await queue.enqueue({
      appId: "agenda",
      action: "create",
      input: { title: "A" },
      optimistic: [
        {
          op: "delete",
          shapeId: "shape-agenda",
          entity: "core.task",
          rowId: "task-1",
        },
        {
          op: "delete",
          shapeId: "shape-notes",
          entity: "core.task",
          rowId: "task-2",
        },
        {
          op: "delete",
          shapeId: "shape-agenda",
          entity: "knowledge.note",
          rowId: "note-1",
        },
      ],
    });

    await expect(queue.overlayMutations("shape-agenda")).resolves.toMatchObject(
      [{ rowId: "task-1" }, { rowId: "note-1" }]
    );
    await expect(
      queue.overlayMutations(undefined, "core.task")
    ).resolves.toMatchObject([{ rowId: "task-1" }, { rowId: "task-2" }]);
  });

  test("journals a denied write for attention while it leaves the overlay", async () => {
    const store = new MemoryIntentStore();
    const queue = new IntentQueue(store, { idFactory: () => "intent-denied" });
    const optimistic = [
      {
        op: "upsert" as const,
        shapeId: "shape-agenda",
        entity: "core.task",
        rowId: "pending-intent-denied",
        values: { title: "Ship the thing" },
      },
    ];
    await queue.enqueue({
      appId: "agenda",
      action: "create",
      input: { title: "Ship the thing" },
      optimistic,
    });
    await queue.claimNext();
    await queue.applyOutcomes([
      { intentId: "intent-denied", status: "denied", reason: "owner denied" },
    ]);

    // The overlay is gone — a denied write must stop composing reads.
    await expect(queue.list()).resolves.toStrictEqual([]);
    await expect(queue.overlayMutations()).resolves.toStrictEqual([]);
    // The ROW is not gone. Without this journal a denied create leaves every
    // read and the member never learns it was refused (issue #738).
    await expect(queue.attention()).resolves.toStrictEqual([
      {
        intentId: "intent-denied",
        status: "denied",
        appId: "agenda",
        action: "create",
        reason: "owner denied",
        optimistic,
        input: { title: "Ship the thing" },
        settledAt: expect.any(String),
      },
    ]);
  });

  test("journals a conflict with its expected vs actual versions, and nothing for an execution", async () => {
    const queue = new IntentQueue(new MemoryIntentStore(), {
      idFactory: () => "intent-conflict",
    });
    const conflict = {
      shapeId: "shape-agenda",
      entity: "core.event",
      rowId: "event-1",
      expectedVersion: 4,
      actualVersion: 5,
    };
    await queue.enqueue({ appId: "agenda", action: "edit", input: {} });
    await queue.claimNext();
    await queue.applyOutcomes([
      { intentId: "intent-conflict", status: "conflict", conflict },
    ]);
    await expect(queue.attention()).resolves.toMatchObject([
      { intentId: "intent-conflict", status: "conflict", conflict },
    ]);

    const executed = new IntentQueue(new MemoryIntentStore(), {
      idFactory: () => "intent-executed",
    });
    await executed.enqueue({ appId: "agenda", action: "edit", input: {} });
    await executed.claimNext();
    await executed.applyOutcomes([
      { intentId: "intent-executed", status: "executed" },
    ]);
    // An executed write has a canonical row to show for itself; journaling
    // its payload would retain member content for nothing.
    await expect(executed.attention()).resolves.toStrictEqual([]);
  });

  test("an attention record leaves only when the member answers it", async () => {
    const queue = new IntentQueue(new MemoryIntentStore(), {
      idFactory: () => "intent-failed",
    });
    await queue.enqueue({ appId: "agenda", action: "edit", input: {} });
    await queue.claimNext();
    await queue.applyOutcomes([
      { intentId: "intent-failed", status: "failed", reason: "handler threw" },
    ]);

    // Reading it, and reading the outbox around it, never prunes it.
    await expect(queue.pending()).resolves.toStrictEqual([]);
    await expect(queue.attention()).resolves.toHaveLength(1);
    await expect(queue.dismissAttention("intent-failed")).resolves.toBe(true);
    await expect(queue.attention()).resolves.toStrictEqual([]);
    await expect(queue.dismissAttention("intent-failed")).resolves.toBe(false);
  });

  test("delegates close to the durable store", () => {
    const store = new MemoryIntentStore();
    const close = vi.spyOn(store, "close");
    const queue = new IntentQueue(store);

    queue.close();

    expect(close).toHaveBeenCalledOnce();
  });
});
