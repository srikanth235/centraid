// The Tasks write door: a HOUSE-scope act stays in HOUSE, and Delete removes
// the row instead of cancelling it (#864). Pure so both seats share one answer.
import { describe, expect, it } from "vitest";

import { removeTaskWrite, taskWrite } from "./writes.ts";

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

describe("delete-confirm removes the row, it does not cancel it", () => {
  it("dispatches delete, never a cancelled status", () => {
    expect(removeTaskWrite("t1")).toStrictEqual({
      action: "delete",
      input: { task_id: "t1" },
    });
  });
});
