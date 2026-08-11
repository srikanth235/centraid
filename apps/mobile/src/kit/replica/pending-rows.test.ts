// What a list row may say about itself while its write is unsettled (#738).

import { describe, expect, test } from "vitest";

import type { PendingChange } from "./pending-changes";
import { pendingRowMarks } from "./pending-rows";

const queued: PendingChange = {
  id: "intent-1",
  vaultId: "personal",
  vaultLabel: "Personal",
  status: "queued",
  label: "tasks: add",
  kind: "replica",
  appId: "tasks",
  rowIds: ["pending-intent-1"],
};

describe(pendingRowMarks, () => {
  test("marks every row an unsettled write projected into", () => {
    const marks = pendingRowMarks(
      [{ ...queued, rowIds: ["pending-intent-1", "expense-7"] }],
      "tasks",
      true
    );

    expect(marks.get("pending-intent-1")).toStrictEqual({
      intentId: "intent-1",
      status: "queued",
      label: "pending",
      reason: "Saved on this device; waiting for a connection.",
    });
    expect(marks.get("expense-7")?.intentId).toBe("intent-1");
  });

  test("marks only the asking app's rows", () => {
    const marks = pendingRowMarks([queued], "notes", true);

    expect(marks.size).toBe(0);
  });

  test("prints the gateway's own reason verbatim", () => {
    const marks = pendingRowMarks(
      [{ ...queued, status: "parked", reason: "Ada has to approve this." }],
      "tasks",
      true
    );

    expect(marks.get("pending-intent-1")).toMatchObject({
      label: "waiting",
      reason: "Ada has to approve this.",
    });
  });

  test("says a parked write waits on a connection while offline", () => {
    const marks = pendingRowMarks(
      [{ ...queued, status: "parked" }],
      "tasks",
      false
    );

    expect(marks.get("pending-intent-1")?.reason).toBe(
      "Saved on this device; waiting for a connection."
    );
  });

  test("leaves settled and placement changes to the sync-status sheet", () => {
    const marks = pendingRowMarks(
      [
        { ...queued, status: "denied" },
        { ...queued, kind: "placement", id: "link-1" },
      ],
      "tasks",
      true
    );

    expect(marks.size).toBe(0);
  });
});
