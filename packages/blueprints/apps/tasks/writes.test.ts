// The Tasks write door: a HOUSE-scope act stays in HOUSE, and Delete removes
// the row instead of cancelling it (#864). Pure so both seats share one answer.
import { describe, expect, it } from "vitest";

import {
  isPendingTaskId,
  landedTask,
  mountedWriteScope,
  removeTaskWrite,
  taskWrite,
} from "./writes.ts";

describe("a HOUSE-scope write stays in the HOUSE scope", () => {
  it("forwards the HOUSE scope on the write, never the ambient own scope", () => {
    expect(
      taskWrite({
        action: "set-status",
        input: { task_id: "t1", status: "completed" },
        scopeId: "house",
      })
    ).toStrictEqual({
      action: "set-status",
      input: { task_id: "t1", status: "completed" },
      scope: "house",
    });
  });

  it("omits scope when the row lives in the member's own space", () => {
    expect(
      taskWrite({
        action: "add",
        input: { title: "Buy milk" },
        scopeId: "",
      }).scope
    ).toBeUndefined();
  });
});

describe("a write names a HOUSE scope only when that house is mounted", () => {
  it("forwards a mounted id and drops one the inline client does not have", () => {
    expect(mountedWriteScope("house", ["own", "house"])).toBe("house");
    expect(mountedWriteScope("stranger", ["own", "house"])).toBeNull();
    expect(mountedWriteScope("", ["own"])).toBeNull();
    expect(mountedWriteScope(undefined, ["own"])).toBeNull();
  });
});

describe("completing an optimistic add waits for the landed row", () => {
  const pending = {
    task_id: "pending:intent-1:task",
    title: "Renew the passport",
  };
  const landed = {
    task_id: "task-real",
    title: "Renew the passport",
  };

  it("recognises the synthetic pending id", () => {
    expect(isPendingTaskId(pending.task_id)).toBe(true);
    expect(isPendingTaskId(landed.task_id)).toBe(false);
  });

  it("resolves a pending add to the vault row of the same title", () => {
    expect(landedTask(pending, [landed])).toStrictEqual(landed);
    expect(landedTask(pending, [pending])).toBeUndefined();
    expect(landedTask(landed, [landed])).toStrictEqual(landed);
  });
});

describe("delete-confirm removes the row, it does not cancel it", () => {
  it("dispatches delete, never a cancelled status", () => {
    expect(removeTaskWrite("t1")).toStrictEqual({
      action: "delete",
      input: { task_id: "t1" },
    });
  });
});
