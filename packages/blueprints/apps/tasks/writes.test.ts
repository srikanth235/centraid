// The Tasks write door: a HOUSE-scope act stays in HOUSE, and Delete removes
// the row instead of cancelling it (#864). Pure so both seats share one answer.
import { describe, expect, it } from "vitest";

import {
  boardTask,
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

// #922 G2: there is no landed id to wait for. The projection mints the task's
// real id, the write carries it, the origin honours it — so the row a
// completion names is the row the member is looking at, queued or not.
describe("completing an optimistic add names the same row either way", () => {
  const queued = {
    task_id: "1f2e3d4c-0000-8000-8000-0000000000aa",
    title: "Renew the passport",
  };
  const other = { task_id: "task-real", title: "Renew the passport" };

  it("finds the task by its id, never by its title", () => {
    expect(boardTask(queued, [queued])).toStrictEqual(queued);
    expect(boardTask(queued, [other])).toBeUndefined();
    expect(boardTask(other, [queued, other])).toStrictEqual(other);
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
