// What a list row may say about itself while its write is unsettled (#738).

import { describe, expect, test } from "vitest";

import type { PendingChange } from "./pending-changes";
import { attentionRowCopy, pendingRowMarks } from "./pending-rows";

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

describe(attentionRowCopy, () => {
  test("prints the gateway's own reason verbatim for a denial", () => {
    expect(
      attentionRowCopy({ status: "denied", reason: "Ada has to approve this." })
    ).toStrictEqual({ label: "denied", reason: "Ada has to approve this." });
  });

  test("falls back to the shared refusal grammar with no gateway reason", () => {
    expect(attentionRowCopy({ status: "failed" })).toStrictEqual({
      label: "failed",
      reason: "This change could not be applied.",
    });
  });

  // Issue #738 P3: a conflict must NAME its expected/actual versions, not
  // print the generic "someone else changed this" line — the two facts a
  // member needs to decide whether retrying even makes sense.
  test("names expected vs actual versions for a conflict, ignoring any generic reason", () => {
    expect(
      attentionRowCopy({
        status: "conflict",
        reason: "a generic transport reason that must not win",
        conflict: {
          entity: "schedule.task",
          rowId: "task-1",
          expectedVersion: 2,
          actualVersion: 5,
        },
      })
    ).toStrictEqual({
      label: "conflict",
      reason: "Expected version 2, but it is now version 5.",
    });
  });

  test("falls back to the generic conflict line when no version detail is journaled", () => {
    expect(attentionRowCopy({ status: "conflict" })).toStrictEqual({
      label: "conflict",
      reason: "Someone else changed this first.",
    });
  });
});
