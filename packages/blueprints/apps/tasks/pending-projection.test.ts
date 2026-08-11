// @vitest-environment jsdom
//
// Tasks' pending-write overlay (issue #738): the declaration's pure
// projections (mirrors pending-overlay.test.ts's per-app-declaration
// convention), plus one reload-survival behavioral test through
// `createLogic` — a queued add the durable outbox reports on mount must
// still render as pending after a reload with no in-memory state at all.
import { describe, expect, test, vi } from "vitest";

import { createLogic } from "./logic.ts";
import { tasksPendingProjection } from "./pending-projection.ts";
import type { AppState, BoardData } from "./types.ts";

function ctx(intentId: string) {
  return { intentId, rowId: `pending-${intentId}` };
}

describe("Tasks pending-write projection", () => {
  test("add upserts a new needs-action row under the minted id", () => {
    expect(
      tasksPendingProjection.actions.add!(
        { title: "Ship the thing", due_at: "2026-08-12", priority: 1 },
        ctx("intent-1")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "schedule.task",
        rowId: "pending-intent-1",
        values: {
          task_id: "pending-intent-1",
          title: "Ship the thing",
          status: "needs-action",
          priority: 1,
          due_at: "2026-08-12",
        },
      },
    ]);
  });

  test("add defaults priority to 0 and forwards only the fields present", () => {
    expect(
      tasksPendingProjection.actions.add!(
        { title: "Loose task" },
        ctx("intent-2")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "schedule.task",
        rowId: "pending-intent-2",
        values: {
          task_id: "pending-intent-2",
          title: "Loose task",
          status: "needs-action",
          priority: 0,
        },
      },
    ]);
  });

  test("set-status stamps completed_at iff the new status is completed", () => {
    expect(
      tasksPendingProjection.actions["set-status"]!(
        { task_id: "task-1", status: "completed" },
        ctx("intent-3")
      )
    ).toMatchObject([
      {
        op: "upsert",
        entity: "schedule.task",
        rowId: "task-1",
        values: { status: "completed", completed_at: expect.any(String) },
      },
    ]);

    expect(
      tasksPendingProjection.actions["set-status"]!(
        { task_id: "task-1", status: "needs-action" },
        ctx("intent-4")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "schedule.task",
        rowId: "task-1",
        values: { status: "needs-action", completed_at: null },
      },
    ]);
  });

  test("edit projects only the fields present, honoring clear_* flags", () => {
    expect(
      tasksPendingProjection.actions.edit!(
        {
          task_id: "task-1",
          title: "Renamed",
          clear_due: true,
          priority: 2,
        },
        ctx("intent-5")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "schedule.task",
        rowId: "task-1",
        values: { title: "Renamed", due_at: null, priority: 2 },
      },
    ]);
  });

  test("save-project/save-section/organize-task are deliberately undeclared", () => {
    expect(tasksPendingProjection.actions["save-project"]).toBeUndefined();
    expect(tasksPendingProjection.actions["save-section"]).toBeUndefined();
    expect(tasksPendingProjection.actions["organize-task"]).toBeUndefined();
  });
});

function state(): AppState {
  return {
    view: "today",
    search: "",
    searchResults: null,
    searchSnippets: null,
    boardWindow: 500,
    boardTruncated: false,
    boardReach: [],
    detailId: null,
    narrow: false,
    activityLog: new Map(),
    readFailedShown: false,
  };
}

function data(): BoardData {
  return {
    open: [],
    logbook: [],
    counts: {},
    projects: [],
    sections: [],
    window: 500,
  };
}

describe("Tasks pending-write reload survival", () => {
  test("a queued add the durable outbox reports on mount renders pending with no prior in-memory state", async () => {
    const pendingWrites = vi.fn<
      NonNullable<typeof window.centraid.pendingWrites>
    >(async () => [
      {
        intentId: "intent-reload",
        action: "add",
        state: "queued",
        input: { title: "Ship the thing" },
        mutations: [
          {
            op: "upsert",
            entity: "schedule.task",
            rowId: "pending-intent-reload",
            values: {
              task_id: "pending-intent-reload",
              title: "Ship the thing",
              status: "needs-action",
              priority: 0,
            },
          },
        ],
      },
    ]);
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: { pendingWrites },
    });

    const render = vi.fn<() => void>();
    // A fresh logic instance — the model starts empty; `restorePending()` is
    // the ONLY path that can populate it, exactly the reload journey.
    const logic = createLogic({
      state: state(),
      data: data(),
      render,
      refresh: vi.fn<() => Promise<void>>(async () => undefined),
    });

    expect(logic.pendingByRowId().size).toBe(0);
    await logic.restorePending();

    expect(pendingWrites).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledWith();
    const byRowId = logic.pendingByRowId();
    expect(byRowId.has("pending-intent-reload")).toBe(true);
    expect(byRowId.get("pending-intent-reload")).toMatchObject({
      action: "add",
      status: "queued",
    });

    // Board.tsx's decoration path: the row this write projects now belongs
    // to the board's normal query rows (overlay-composed) — the model only
    // needs to answer "is this row pending" for it.
    const boardData = data();
    boardData.open = [
      {
        task_id: "pending-intent-reload",
        status: "needs-action",
        title: "Ship the thing",
      },
    ];
    expect(byRowId.get(boardData.open[0]!.task_id)).toBeDefined();
  });

  test("a denied add persists with its reason across a reload, then retries under a fresh id", async () => {
    // The durable attention journal the client store keeps (issue #738): the
    // outbox drops a settled intent, so this is the ONLY thing that can bring
    // a denied create back after a reload.
    const journal: NonNullable<
      Awaited<ReturnType<NonNullable<typeof window.centraid.attentionWrites>>>
    > = [];
    const write = vi.fn<typeof window.centraid.write>(async (opts) => {
      journal.push({
        intentId: opts.intentId!,
        action: opts.action,
        status: "denied",
        reason: "The owner has not allowed this.",
        input: opts.input ?? {},
        mutations: (opts.optimistic ?? []) as never,
        settledAt: "2026-08-11T10:00:00.000Z",
      });
      return {
        status: "denied",
        invocationId: opts.intentId,
        reason: "The owner has not allowed this.",
      } as never;
    });
    const dismissAttentionWrite = vi.fn<
      NonNullable<typeof window.centraid.dismissAttentionWrite>
    >(async ({ intentId }) => {
      const at = journal.findIndex((row) => row.intentId === intentId);
      if (at < 0) return false;
      journal.splice(at, 1);
      return true;
    });
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: {
        write,
        pendingWrites: async () => [],
        attentionWrites: async () => journal.map((row) => ({ ...row })),
        dismissAttentionWrite,
      },
    });

    const first = createLogic({
      state: state(),
      data: data(),
      render: vi.fn<() => void>(),
      refresh: vi.fn<() => Promise<void>>(async () => undefined),
    });
    await first.write("add", { title: "Ship the thing" });
    const deniedId = write.mock.calls[0]![0].intentId!;
    expect(first.attentionRows()).toMatchObject([
      {
        action: "add",
        status: "denied",
        reason: "The owner has not allowed this.",
      },
    ]);
    // The replica stopped composing the mutation, so the board's own rows no
    // longer contain it — the attention entry is the only thing still holding
    // the row it projected.
    expect(first.attentionRows()[0]!.rowIds).toStrictEqual([
      `pending-${deniedId}`,
    ]);

    // ---- reload: a brand-new logic instance with no memory at all ----
    const second = createLogic({
      state: state(),
      data: data(),
      render: vi.fn<() => void>(),
      refresh: vi.fn<() => Promise<void>>(async () => undefined),
    });
    expect(second.attentionRows()).toStrictEqual([]);
    await second.restorePending();
    expect(second.attentionRows()).toMatchObject([
      {
        intentId: deniedId,
        action: "add",
        status: "denied",
        reason: "The owner has not allowed this.",
        input: { title: "Ship the thing" },
      },
    ]);

    // ---- retry: same payload, FRESH intent id, old record forgotten ----
    await second.retryPending(deniedId);
    expect(dismissAttentionWrite).toHaveBeenCalledWith({ intentId: deniedId });
    const retried = write.mock.calls[1]![0];
    expect(retried.input).toStrictEqual({ title: "Ship the thing" });
    expect(retried.intentId).not.toBe(deniedId);
    // The retry was denied too, so exactly one row is answerable — the new
    // attempt — and the old id is not resurrected by the journal.
    expect(second.attentionRows()).toMatchObject([
      { intentId: retried.intentId, action: "add", status: "denied" },
    ]);
  });

  test("a discarded row stays discarded across a reload", async () => {
    const journal: NonNullable<
      Awaited<ReturnType<NonNullable<typeof window.centraid.attentionWrites>>>
    > = [
      {
        intentId: "intent-denied",
        action: "add",
        status: "denied",
        reason: "The owner has not allowed this.",
        input: { title: "Ship the thing" },
        mutations: [],
        settledAt: "2026-08-11T10:00:00.000Z",
      },
    ];
    const dismissAttentionWrite = vi.fn<
      NonNullable<typeof window.centraid.dismissAttentionWrite>
    >(async ({ intentId }) => {
      const at = journal.findIndex((row) => row.intentId === intentId);
      if (at < 0) return false;
      journal.splice(at, 1);
      return true;
    });
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: {
        pendingWrites: async () => [],
        attentionWrites: async () => journal.map((row) => ({ ...row })),
        dismissAttentionWrite,
      },
    });

    const before = createLogic({
      state: state(),
      data: data(),
      render: vi.fn<() => void>(),
      refresh: vi.fn<() => Promise<void>>(async () => undefined),
    });
    await before.restorePending();
    expect(before.attentionRows()).toHaveLength(1);
    expect(before.dismissPending("intent-denied")).toBe(true);
    expect(before.attentionRows()).toStrictEqual([]);
    // Discard reaches the DURABLE record — without this the next reload
    // brings the row straight back, which is not discarding.
    expect(dismissAttentionWrite).toHaveBeenCalledWith({
      intentId: "intent-denied",
    });
    expect(journal).toStrictEqual([]);

    const after = createLogic({
      state: state(),
      data: data(),
      render: vi.fn<() => void>(),
      refresh: vi.fn<() => Promise<void>>(async () => undefined),
    });
    await after.restorePending();
    expect(after.attentionRows()).toStrictEqual([]);
  });

  test("an edit carries the row version it was composed against, a create carries none", async () => {
    const write = vi.fn<typeof window.centraid.write>(
      async () => ({ status: "executed" }) as never
    );
    const rowVersion = vi.fn<NonNullable<typeof window.centraid.rowVersion>>(
      async () => 7
    );
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: { write, rowVersion, pendingWrites: async () => [] },
    });
    const logic = createLogic({
      state: state(),
      data: data(),
      render: vi.fn<() => void>(),
      refresh: vi.fn<() => Promise<void>>(async () => undefined),
    });

    await logic.write("edit", { task_id: "task-1", title: "Renamed" });
    expect(rowVersion).toHaveBeenCalledWith({
      entity: "schedule.task",
      rowId: "task-1",
    });
    expect(write.mock.calls[0]![0].baseVersions).toStrictEqual([
      { entity: "schedule.task", rowId: "task-1", version: 7 },
    ]);

    // A create has no existing row to be stale against.
    await logic.write("add", { title: "Fresh" });
    expect(write.mock.calls[1]![0].baseVersions).toBeUndefined();
  });

  test("restorePending() is a safe no-op when the host has no pendingWrites (visual-harness mock)", async () => {
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: {},
    });
    const render = vi.fn<() => void>();
    const logic = createLogic({
      state: state(),
      data: data(),
      render,
      refresh: vi.fn<() => Promise<void>>(async () => undefined),
    });

    await expect(logic.restorePending()).resolves.toBeUndefined();
    expect(logic.pendingByRowId().size).toBe(0);
  });
});

// Issue #738 re-audit: a host without the durable surfaces — the served
// bridge and the visual-harness mock are both real examples — used to fold
// "no answer" into an empty outbox, and the restore then pruned the very row
// it was meant to preserve.
describe("Tasks restore against a host with no durable surfaces", () => {
  test("leaves a queued row alone instead of pruning it away", async () => {
    Object.defineProperty(window, "centraid", {
      configurable: true,
      // A host that can write but exposes neither durable surface.
      value: {
        write: vi.fn<() => Promise<VaultOutcome>>(async () => ({
          status: "queued",
          invocationId: "i-1",
        })),
      },
    });
    const logic = createLogic({
      state: state(),
      data: data(),
      render: vi.fn<() => void>(),
      refresh: vi.fn<() => Promise<void>>(async () => undefined),
    });

    await logic.act("add", { title: "Buy milk" });
    expect(logic.pendingByRowId().size).toBe(1);

    await logic.restorePending();

    expect(logic.pendingByRowId().size).toBe(1);
  });
});
