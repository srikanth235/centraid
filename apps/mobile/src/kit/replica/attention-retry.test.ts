// What a retry re-issues for one attention row (issue #738 gap 1): the same
// action and journaled payload, projected under whatever id the caller
// mints — never the id it is called with, since the whole point is that the
// caller mints a FRESH one (native-session.ts `mintIntentId`).

import { describe, expect, test } from "vitest";

import { attentionRetryWrite } from "./attention-retry";

describe(attentionRetryWrite, () => {
  test("re-projects the journaled payload through the app's own declaration", () => {
    const write = attentionRetryWrite({
      appId: "tasks",
      action: "add",
      input: { title: "Beach house", priority: 2 },
    });

    expect(write.action).toBe("add");
    expect(write.input).toStrictEqual({ title: "Beach house", priority: 2 });
    expect(write.optimistic).toBeTypeOf("function");
    // The projection is a function of whatever id the write ultimately ships
    // under (mirrors `NativeOptimisticProjection`) — two different ids
    // project two different pending rows for the exact same payload.
    expect(write.optimistic?.("intent-fresh")).toStrictEqual([
      {
        op: "upsert",
        entity: "schedule.task",
        rowId: "pending-intent-fresh",
        values: {
          task_id: "pending-intent-fresh",
          title: "Beach house",
          status: "needs-action",
          priority: 2,
        },
      },
    ]);
    expect(write.optimistic?.("intent-fresh")[0]?.rowId).not.toBe(
      write.optimistic?.("intent-other")[0]?.rowId
    );
  });

  test("defaults to an empty payload when the journal carried none", () => {
    const write = attentionRetryWrite({ appId: "tasks", action: "add" });

    expect(write.input).toStrictEqual({});
  });

  test("still retries an app with no pending-projection declaration, with no optimistic row", () => {
    const write = attentionRetryWrite({
      appId: "automations",
      action: "toggle",
      input: { automation_id: "auto-1", enabled: false },
    });

    expect(write).toStrictEqual({
      action: "toggle",
      input: { automation_id: "auto-1", enabled: false },
    });
  });

  test("an app's undeclared action also retries with no optimistic row", () => {
    // Tasks declares `add`/`edit`/`set-status` but not `organize-task`
    // (packages/blueprints/apps/tasks/pending-projection.ts) — the write
    // still ships, it just renders no pending row until the next read.
    const write = attentionRetryWrite({
      appId: "tasks",
      action: "organize-task",
      input: { task_id: "task-1", project_id: "project-1" },
    });

    expect(write.optimistic?.("intent-fresh")).toStrictEqual([]);
  });
});
