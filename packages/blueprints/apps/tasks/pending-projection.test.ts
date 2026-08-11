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
