import { describe, expect, test } from "vitest";

import { MemoryIntentStore } from "./intent-store.js";
import { IntentQueue } from "./intents.js";

describe(IntentQueue, () => {
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
    await queue.applyOutcomes([
      {
        intentId: "intent-conflict",
        status: "conflict",
        reason: "canonical row changed",
        conflict,
      },
    ]);

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
});
