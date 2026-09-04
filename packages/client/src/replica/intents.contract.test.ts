// governance: allow-repo-hygiene file-size-limit #738 cohesive intent lifecycle contract
import { describe, expect, test, vi } from "vitest";

import { stablePendingRowId } from "@centraid/blueprints/apps/_shared/pending-overlay";
import { useFakeClock } from "@centraid/test-kit/fake-clock";

import { MemoryIntentStore } from "./intent-store.js";
import {
  IntentQueue,
  pendingIntentIdFromInput,
  SHAPE_REVOKED_REASON,
} from "./intents.js";
import type { ReplicaValue } from "./types.js";

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

  test("parked and denied overlays survive reload-length waits until discard", async () => {
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
    await expect(queue.overlayMutations()).resolves.toMatchObject([
      {
        values: {
          __centraid_pending_key: "intent-parked",
          __centraid_pending_status: "denied",
          __centraid_pending_reason: "owner denied",
        },
      },
    ]);
    expect(denied).toMatchObject({ state: "denied", reason: "owner denied" });
    await expect(queue.list()).resolves.toMatchObject([
      { intentId: "intent-parked", state: "denied" },
    ]);
    await expect(queue.discard("intent-parked")).resolves.toBe(true);
    await expect(queue.overlayMutations()).resolves.toStrictEqual([]);
    await expect(queue.listSettled()).resolves.toMatchObject([
      {
        intentId: "intent-parked",
        status: "denied",
        reason: "owner denied",
      },
    ]);
  });

  test("stamps the first admission so every rail can age a stuck write", async () => {
    const clock = useFakeClock("2026-08-27T09:00:00.000Z");
    const queue = new IntentQueue(new MemoryIntentStore(), {
      idFactory: () => "intent-stamped",
    });
    const write = {
      appId: "agenda",
      action: "complete",
      input: { taskId: "task-1" },
    };
    await expect(queue.enqueue(write)).resolves.toMatchObject({
      enqueuedAt: "2026-08-27T09:00:00.000Z",
    });

    // A replayed id is the same durable admission, so its age keeps running.
    clock.set("2026-08-27T09:30:00.000Z");
    await expect(queue.enqueue(write)).resolves.toMatchObject({
      enqueuedAt: "2026-08-27T09:00:00.000Z",
    });
    await expect(queue.overlayMutations()).resolves.toStrictEqual([]);
  });

  test("Commons expiry dismissal may remove a locally parked row without recording execution", async () => {
    const queue = new IntentQueue(new MemoryIntentStore());
    await queue.enqueue({
      intentId: "intent-expired-commons",
      appId: "tally",
      action: "add-expense",
      input: { description: "Lunch" },
      optimistic: [
        {
          op: "upsert",
          shapeId: "shape-tally",
          entity: "tally.expense",
          rowId: stablePendingRowId("intent-expired-commons", "expense"),
          values: { description: "Lunch" },
        },
      ],
    });
    await queue.claimNext();
    await queue.applyOutcomes([
      {
        intentId: "intent-expired-commons",
        status: "parked",
        reason: "Waiting for the steward.",
      },
    ]);

    await expect(queue.discard("intent-expired-commons")).resolves.toBe(true);
    await expect(queue.overlayMutations()).resolves.toStrictEqual([]);
    await expect(queue.listSettled()).resolves.toMatchObject([
      {
        intentId: "intent-expired-commons",
        status: "parked",
        reason: "Waiting for the steward.",
      },
    ]);
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

  test("retains structured terminal conflicts with versions for edit/retry/discard", async () => {
    const queue = new IntentQueue(new MemoryIntentStore(), {
      idFactory: () => "intent-conflict",
    });
    await queue.enqueue({
      appId: "agenda",
      action: "edit",
      input: { title: "offline" },
      optimistic: [
        {
          op: "upsert",
          shapeId: "shape-agenda",
          entity: "core.event",
          rowId: "event-1",
          values: { title: "offline" },
        },
      ],
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

    // #922 G5: a conflict is its OWN state, not `failed` wearing a detail.
    expect(settled).toMatchObject({ state: "conflict", conflict });
    await expect(queue.list()).resolves.toMatchObject([
      { intentId: "intent-conflict", state: "conflict", conflict },
    ]);
    await expect(queue.overlayMutations()).resolves.toMatchObject([
      {
        values: {
          __centraid_pending_status: "conflict",
          __centraid_pending_expected_version: 4,
          __centraid_pending_actual_version: 5,
        },
      },
    ]);
    await expect(queue.listSettled()).resolves.toStrictEqual([]);
  });

  // A conflict whose BASE ROW IS GONE gets its own verdict (#922 G5): there is
  // nothing to compare against, so "look before you retry" is the wrong advice.
  test("a conflict whose base row is gone is its own state", async () => {
    const queue = new IntentQueue(new MemoryIntentStore(), {
      idFactory: () => "intent-gone",
    });
    await queue.enqueue({
      appId: "agenda",
      action: "edit",
      input: { title: "offline" },
      optimistic: [
        {
          op: "upsert",
          shapeId: "shape-agenda",
          entity: "core.event",
          rowId: "event-1",
          values: { title: "offline" },
        },
      ],
    });
    await queue.claimNext();
    const [settled] = await queue.applyOutcomes([
      {
        intentId: "intent-gone",
        status: "conflict",
        reason: "the row is gone",
        conflict: {
          shapeId: "shape-agenda",
          entity: "core.event",
          rowId: "event-1",
          expectedVersion: 4,
          actualVersion: 0,
        },
      },
    ]);
    expect(settled).toMatchObject({ state: "conflict-base-missing" });
  });

  // `denied` carries a STRUCTURED refusal, so a seat never parses prose.
  test("a denial is structured even before #928 fills it", async () => {
    const queue = new IntentQueue(new MemoryIntentStore(), {
      idFactory: () => "intent-denied",
    });
    await queue.enqueue({
      appId: "agenda",
      action: "edit",
      input: { title: "offline" },
      optimistic: [
        {
          op: "upsert",
          shapeId: "shape-agenda",
          entity: "core.event",
          rowId: "event-2",
          values: { title: "offline" },
        },
      ],
    });
    await queue.claimNext();
    const [settled] = await queue.applyOutcomes([
      {
        intentId: "intent-denied",
        status: "denied",
        reason: "the grant was revoked",
      },
    ]);
    expect(settled).toMatchObject({
      state: "denied",
      denial: { code: "denied", message: "the grant was revoked" },
    });
  });

  test("revises a terminal add with a fresh immutable intent and settles the old result honestly", async () => {
    const queue = new IntentQueue(new MemoryIntentStore(), {
      idFactory: () => "intent-replacement",
    });
    await queue.enqueue({
      intentId: "intent-original",
      appId: "tasks",
      action: "add",
      input: { title: "Original", due_at: "2026-08-11" },
      optimistic: [
        {
          op: "upsert",
          shapeId: "shape-tasks",
          entity: "schedule.task",
          rowId: stablePendingRowId("intent-original", "task"),
          values: {
            task_id: stablePendingRowId("intent-original", "task"),
            title: "Original",
          },
        },
      ],
    });
    await queue.claimNext();
    await queue.applyOutcomes([
      {
        intentId: "intent-original",
        status: "failed",
        reason: "title needs attention",
      },
    ]);

    await expect(
      queue.revise(
        "intent-original",
        {
          task_id: stablePendingRowId("intent-original", "task"),
          title: "Wrong action",
        },
        undefined,
        ["save-project"]
      )
    ).resolves.toBeUndefined();

    await expect(
      queue.revise(
        "intent-original",
        {
          task_id: stablePendingRowId("intent-original", "task"),
          title: "Edited locally",
        },
        undefined,
        ["add"]
      )
    ).resolves.toMatchObject({
      action: "add",
      input: { title: "Edited locally", due_at: "2026-08-11" },
      intentId: "intent-replacement",
      state: "queued",
    });
    await expect(queue.list()).resolves.toMatchObject([
      {
        action: "add",
        input: { title: "Edited locally", due_at: "2026-08-11" },
        intentId: "intent-replacement",
      },
    ]);
    await expect(queue.overlayMutations()).resolves.toMatchObject([
      {
        entity: "schedule.task",
        rowId: stablePendingRowId("intent-replacement", "task"),
        values: {
          __centraid_pending_key: "intent-replacement",
          title: "Edited locally",
        },
      },
    ]);
    await expect(queue.listSettled()).resolves.toMatchObject([
      {
        intentId: "intent-original",
        status: "failed",
        reason: "title needs attention",
      },
    ]);
  });

  test("restart finishes an interrupted add-first replacement without duplicate overlays", async () => {
    const store = new MemoryIntentStore();
    const queue = new IntentQueue(store, {
      idFactory: () => "intent-replacement",
    });
    await queue.enqueue({
      intentId: "intent-original",
      appId: "tasks",
      action: "add",
      input: { title: "Original" },
      optimistic: [
        {
          op: "upsert",
          shapeId: "shape-tasks",
          entity: "schedule.task",
          rowId: stablePendingRowId("intent-original", "task"),
          values: {
            task_id: stablePendingRowId("intent-original", "task"),
            title: "Original",
          },
        },
      ],
    });
    await queue.claimNext();
    await queue.applyOutcomes([
      { intentId: "intent-original", status: "failed", reason: "fix it" },
    ]);
    vi.spyOn(store, "settle").mockRejectedValueOnce(
      new Error("simulated interruption after replacement add")
    );

    await expect(queue.retry("intent-original")).rejects.toThrow(
      "simulated interruption"
    );
    await expect(queue.list()).resolves.toHaveLength(2);

    const reopened = new IntentQueue(store);
    await reopened.recoverSending();
    await expect(reopened.list()).resolves.toMatchObject([
      { intentId: "intent-replacement", state: "queued" },
    ]);
    await expect(reopened.overlayMutations()).resolves.toMatchObject([
      {
        rowId: stablePendingRowId("intent-replacement", "task"),
        values: { __centraid_pending_key: "intent-replacement" },
      },
    ]);
    await expect(reopened.listSettled()).resolves.toMatchObject([
      { intentId: "intent-original", status: "failed", reason: "fix it" },
    ]);
  });

  test("serializes concurrent retry taps into one durable successor", async () => {
    const store = new MemoryIntentStore();
    const first = new IntentQueue(store, {
      idFactory: () => "intent-replacement-first",
    });
    const second = new IntentQueue(store, {
      idFactory: () => "intent-replacement-second",
    });
    await first.enqueue({
      intentId: "intent-original",
      appId: "tasks",
      action: "edit",
      input: { task_id: "task-1", title: "Edited" },
      optimistic: [
        {
          op: "upsert",
          shapeId: "shape-tasks",
          entity: "schedule.task",
          rowId: "task-1",
          values: { task_id: "task-1", title: "Edited" },
        },
      ],
    });
    await first.claimNext();
    await first.applyOutcomes([
      { intentId: "intent-original", status: "failed", reason: "retry" },
    ]);

    const [left, right] = await Promise.all([
      first.retry("intent-original"),
      second.retry("intent-original"),
    ]);

    expect(left?.intentId).toBe("intent-replacement-first");
    expect(right?.intentId).toBe(left?.intentId);
    await expect(first.list()).resolves.toMatchObject([
      { intentId: "intent-replacement-first", state: "queued" },
    ]);
  });

  test("revises a terminal canonical-row edit by projected row identity", async () => {
    const queue = new IntentQueue(new MemoryIntentStore(), {
      idFactory: () => "intent-canonical-replacement",
    });
    await queue.enqueue({
      intentId: "intent-canonical-original",
      appId: "tasks",
      action: "edit",
      input: { task_id: "task-1", title: "Stale title" },
      optimistic: [
        {
          op: "upsert",
          shapeId: "shape-tasks",
          entity: "schedule.task",
          rowId: "task-1",
          values: { task_id: "task-1", title: "Stale title" },
        },
      ],
    });
    await queue.claimNext();
    await queue.applyOutcomes([
      {
        intentId: "intent-canonical-original",
        status: "denied",
        reason: "revise it",
      },
    ]);

    await expect(
      queue.reviseMatchingProjection(
        "tasks",
        "edit",
        { task_id: "task-1", title: "Correct title" },
        [
          {
            op: "upsert",
            shapeId: "shape-tasks",
            entity: "schedule.task",
            rowId: "task-1",
            values: { task_id: "task-1", title: "Correct title" },
          },
        ]
      )
    ).resolves.toMatchObject({
      supersededIntentId: "intent-canonical-original",
      replacement: {
        intentId: "intent-canonical-replacement",
        input: { task_id: "task-1", title: "Correct title" },
      },
    });
    await expect(queue.list()).resolves.toMatchObject([
      { intentId: "intent-canonical-replacement", state: "queued" },
    ]);
  });

  // #922 G2: the row id no longer spells which intent minted it, so the match
  // is an OUTBOX lookup — exact, and unbothered by what the id looks like.
  // Only a DECLARED revision matches; nothing is guessed from an `*_id`.
  test("recognizes only declared revisions, by asking the outbox", async () => {
    const queue = new IntentQueue(new MemoryIntentStore(), {
      idFactory: () => "intent-original",
    });
    const added = await queue.enqueue({
      appId: "tasks",
      action: "add",
      input: { title: "Offline" },
      optimistic: [
        {
          op: "upsert",
          shapeId: "shape-tasks",
          entity: "schedule.task",
          rowId: "1f2e3d4c-0000-8000-8000-0000000000aa",
          values: { task_id: "1f2e3d4c-0000-8000-8000-0000000000aa" },
        },
      ],
    });
    await expect(
      queue.pendingIntentForInput("tasks", "edit", {
        task_id: added.optimistic[0]?.rowId ?? "",
        title: "Edited locally",
      })
    ).resolves.toStrictEqual({
      intentId: "intent-original",
      expectedActions: ["add"],
    });
    // `add` does not revise anything, and neither does an undeclared pair.
    await expect(
      queue.pendingIntentForInput("tasks", "add", {
        project_id: added.optimistic[0]?.rowId ?? "",
        title: "Child",
      })
    ).resolves.toBeUndefined();
    await expect(
      queue.pendingIntentForInput("tally", "add-expense", {
        group_id: added.optimistic[0]?.rowId ?? "",
        description: "Lunch",
      })
    ).resolves.toBeUndefined();
    // An id no queued intent minted is nobody's revision.
    await expect(
      queue.pendingIntentForInput("tasks", "edit", {
        task_id: "task-1",
        title: "Edited",
      })
    ).resolves.toBeUndefined();
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

  test("delegates close to the durable store", () => {
    const store = new MemoryIntentStore();
    const close = vi.spyOn(store, "close");
    const queue = new IntentQueue(store);

    queue.close();

    expect(close).toHaveBeenCalledOnce();
  });

  test("merges revisions without confusing synthetic identity or clear controls for user data", async () => {
    const queue = new IntentQueue(new MemoryIntentStore(), {
      idFactory: () => "intent-merged",
    });
    await queue.enqueue({
      intentId: "intent-original",
      appId: "tasks",
      action: "add",
      input: {
        id: "original-id",
        __rowId: "original-row",
        task_id: stablePendingRowId("intent-original", "task"),
        title: "Original",
        due_at: "2026-08-12",
        project_id: "project-1",
        remind_before_min: 30,
        rrule: "FREQ=DAILY",
        section_id: "section-1",
        unknown: "remove me",
      },
      optimistic: [
        {
          op: "upsert",
          shapeId: "shape-tasks",
          entity: "schedule.task",
          rowId: stablePendingRowId("intent-original", "task"),
          values: {
            task_id: stablePendingRowId("intent-original", "task"),
            title: "Original",
          },
        },
      ],
    });
    await queue.applyOutcomes([
      { intentId: "intent-original", status: "failed", reason: "revise" },
    ]);

    const revised = await queue.revise("intent-original", {
      // The identity fields that name THIS intent's own projected row are not
      // what the revision is revising, so they never overwrite themselves
      // (#922 G2 — the id no longer spells its intent, the outbox does).
      id: stablePendingRowId("intent-original", "task"),
      __rowId: stablePendingRowId("intent-original", "task"),
      task_id: stablePendingRowId("intent-original", "task"),
      title: "Revised",
      description: "pending:intent-original:ordinary-user-text",
      clear_due: true,
      clear_project: true,
      clear_remind: true,
      clear_rrule: true,
      clear_section: true,
      clear_unknown: true,
      clear_false: false,
    });

    expect(revised?.input).toStrictEqual({
      id: "original-id",
      __rowId: "original-row",
      task_id: stablePendingRowId("intent-original", "task"),
      title: "Revised",
      description: "pending:intent-original:ordinary-user-text",
      clear_false: false,
    });
  });

  test("fails closed for a non-object input or an undeclared pair", async () => {
    const queue = new IntentQueue(new MemoryIntentStore(), {
      idFactory: () => "intent-x",
    });
    const shapes: ReplicaValue[] = [null, "task-1", ["task-1"]];
    for (const input of shapes) {
      // eslint-disable-next-line no-await-in-loop -- (#922) three cheap probes
      await expect(
        queue.pendingIntentForInput("tasks", "edit", input)
      ).resolves.toBeUndefined();
    }
    await expect(
      queue.pendingIntentForInput("unknown-app", "edit", { task_id: "t" })
    ).resolves.toBeUndefined();
    await expect(
      queue.pendingIntentForInput("tasks", "unknown-action", { task_id: "t" })
    ).resolves.toBeUndefined();
  });

  test("preserves the original projection and refreshed versions when an app has no declaration", async () => {
    const queue = new IntentQueue(new MemoryIntentStore(), {
      idFactory: () => "intent-custom-replacement",
    });
    await queue.enqueue({
      intentId: "intent-custom-original",
      appId: "custom-app",
      action: "custom-edit",
      input: "scalar-input",
      optimistic: [
        {
          op: "delete",
          shapeId: "shape-custom",
          entity: "custom.item",
          rowId: "item-1",
        },
      ],
    });
    await queue.applyOutcomes([
      {
        intentId: "intent-custom-original",
        status: "failed",
        reason: "retry",
      },
    ]);

    const replacement = await queue.retry("intent-custom-original", [
      {
        shapeId: "shape-custom",
        entity: "custom.item",
        rowId: "item-1",
        version: 9,
      },
    ]);
    expect(replacement).toMatchObject({
      intentId: "intent-custom-replacement",
      input: "scalar-input",
      baseVersions: [
        {
          shapeId: "shape-custom",
          entity: "custom.item",
          rowId: "item-1",
          version: 9,
        },
      ],
      optimistic: [
        {
          op: "delete",
          shapeId: "shape-custom",
          entity: "custom.item",
          rowId: "item-1",
        },
      ],
    });
  });

  test("rejects replacement id reuse before the durable store sees a changed payload", async () => {
    const queue = new IntentQueue(new MemoryIntentStore(), {
      idFactory: () => "intent-same",
    });
    await queue.enqueue({
      intentId: "intent-same",
      appId: "tasks",
      action: "add",
      input: { title: "Original" },
    });
    await queue.applyOutcomes([
      { intentId: "intent-same", status: "failed", reason: "retry" },
    ]);

    await expect(queue.retry("intent-same")).rejects.toThrow(
      "A pending-write replacement requires a fresh intent id"
    );
  });

  test("canonical revision matching rejects wrong state, app, action, and row candidates", async () => {
    const queue = new IntentQueue(new MemoryIntentStore(), {
      idFactory: () => "intent-correct-replacement",
    });
    const enqueueCandidate = async (
      intentId: string,
      appId: string,
      action: string,
      rowId: string,
      terminal = true
    ): Promise<void> => {
      await queue.enqueue({
        intentId,
        appId,
        action,
        input: { task_id: rowId, title: intentId },
        optimistic: [
          {
            op: "delete",
            shapeId: "shape-tasks",
            entity: "schedule.task",
            rowId: "unrelated-row",
          },
          {
            op: "upsert",
            shapeId: "shape-tasks",
            entity: "schedule.task",
            rowId,
            values: { task_id: rowId, title: intentId },
          },
        ],
      });
      if (terminal)
        await queue.applyOutcomes([
          { intentId, status: "failed", reason: "revise" },
        ]);
    };
    await enqueueCandidate("intent-correct", "tasks", "edit", "task-1");
    await enqueueCandidate("intent-wrong-app", "notes", "edit", "task-1");
    await enqueueCandidate("intent-wrong-action", "tasks", "add", "task-1");
    await enqueueCandidate("intent-wrong-row", "tasks", "edit", "task-2");
    await enqueueCandidate("intent-queued", "tasks", "edit", "task-1", false);

    await expect(
      queue.reviseMatchingProjection(
        "tasks",
        "edit",
        { task_id: "task-1", title: "Correct revision" },
        [
          {
            op: "upsert",
            shapeId: "shape-tasks",
            entity: "schedule.task",
            rowId: "task-1",
            values: { task_id: "task-1", title: "Correct revision" },
          },
        ]
      )
    ).resolves.toMatchObject({
      supersededIntentId: "intent-correct",
      replacement: {
        intentId: "intent-correct-replacement",
        input: { task_id: "task-1", title: "Correct revision" },
      },
    });
  });

  test("uses the browser Web Lock boundary and still retries when navigator is absent", async () => {
    const makeFailedQueue = async (
      intentId: string,
      replacementId: string
    ): Promise<IntentQueue> => {
      const queue = new IntentQueue(new MemoryIntentStore(), {
        idFactory: () => replacementId,
      });
      await queue.enqueue({
        intentId,
        appId: "tasks",
        action: "add",
        input: { title: "Retry" },
      });
      await queue.applyOutcomes([
        { intentId, status: "failed", reason: "retry" },
      ]);
      return queue;
    };
    type LockRequest = <T>(
      name: string,
      callback: () => Promise<T>
    ) => Promise<T>;
    const request = vi.fn<LockRequest>(
      async <T>(_name: string, callback: () => Promise<T>): Promise<T> =>
        callback()
    );
    vi.stubGlobal("navigator", { locks: { request } });
    const locked = await makeFailedQueue("intent-locked", "replacement-locked");
    await expect(locked.retry("intent-locked")).resolves.toMatchObject({
      intentId: "replacement-locked",
    });
    expect(request).toHaveBeenCalledWith(
      "centraid:replica-intent:intent-locked",
      expect.any(Function)
    );

    vi.stubGlobal("navigator", undefined);
    const unlocked = await makeFailedQueue(
      "intent-unlocked",
      "replacement-unlocked"
    );
    await expect(unlocked.retry("intent-unlocked")).resolves.toMatchObject({
      intentId: "replacement-unlocked",
    });
    vi.unstubAllGlobals();
  });

  test("parks, refuses invalid discard, and purges through the durable store", async () => {
    const store = new MemoryIntentStore();
    const destroy = vi.spyOn(store, "destroy");
    const queue = new IntentQueue(store, { idFactory: () => "intent-park" });
    await queue.enqueue({
      appId: "tasks",
      action: "add",
      input: { title: "Park" },
    });
    await queue.claimNext();
    await expect(
      queue.parked("intent-park", "approval")
    ).resolves.toMatchObject({ state: "parked", reason: "approval" });
    await expect(queue.discard("missing")).resolves.toBe(false);
    await queue.purge();
    expect(destroy).toHaveBeenCalledOnce();
  });

  /**
   * A REVOKED SHARE (#929). The shape's rows leave the device, so a write
   * still queued over one of them can never land — and `expired` is the
   * outbox's own word for that, not `failed`, because there is no retry that
   * would work. A write over ANOTHER shape is untouched.
   */
  test("expires the queued writes of a revoked shape and no others", async () => {
    const queue = new IntentQueue(new MemoryIntentStore(), {
      idFactory: (() => {
        let n = 0;
        return () => `intent-shape-${(n += 1)}`;
      })(),
    });
    await queue.enqueue({
      appId: "tally",
      action: "add-expense",
      input: { amount: 1 },
      optimistic: [
        {
          op: "upsert",
          shapeId: "@share:grant-1",
          entity: "tally.expense",
          rowId: "expense-1",
          values: { amount: 1 },
        },
      ],
    });
    await queue.enqueue({
      appId: "tally",
      action: "add-expense",
      input: { amount: 2 },
      dependencies: [{ shapeId: "@share:grant-1", entity: "tally.expense" }],
    });
    await queue.enqueue({
      appId: "agenda",
      action: "create",
      input: { title: "mine" },
      optimistic: [
        {
          op: "upsert",
          shapeId: "agenda:own",
          entity: "core.task",
          rowId: "task-1",
          values: { title: "mine" },
        },
      ],
    });

    const expired = await queue.expireShape("@share:grant-1");
    expect(expired.map((intent) => intent.intentId)).toStrictEqual([
      "intent-shape-1",
      "intent-shape-2",
    ]);
    expect(expired.every((intent) => intent.state === "expired")).toBe(true);
    expect(expired[0]?.reason).toBe(SHAPE_REVOKED_REASON);
    expect(SHAPE_REVOKED_REASON).toBe("no longer shared with you");
    // No pending row survives over a purged shape; the member's own write does.
    const open = await queue.pending();
    expect(
      open
        .filter((intent) => intent.state === "queued")
        .map((intent) => intent.intentId)
    ).toStrictEqual(["intent-shape-3"]);
    // Idempotent: a second purge of the same shape settles nothing again.
    await expect(queue.expireShape("@share:grant-1")).resolves.toStrictEqual(
      []
    );
  });
});
