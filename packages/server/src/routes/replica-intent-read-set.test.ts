// THE DECLARED READ-SET IS PART OF THE CONFLICT CHECK (#996, rulings R6, R21,
// R23).
//
// `baseVersions` used to be whatever the seat chose to send. An intent could
// reference the one row it edited, say nothing about the section it was being
// filed into or the parent it was being nested under, and settle against
// versions nobody had observed — the conflict check answering a question it
// was never asked. The operation declares what it reads; an intent that names
// that operation must reference every one of those rows.

import { describe, expect, test } from "vitest";

import { missingReadSetVersions } from "./replica-intent-shape.js";

const base = (entity: string, rowId: string, version = 3) => ({
  entity,
  rowId,
  version,
});

describe("the intent read-set gate", () => {
  test("an intent naming no operation is unchanged", () => {
    expect(
      missingReadSetVersions(undefined, { task_id: "t1" }, [])
    ).toStrictEqual([]);
  });

  test("a complete base-version set passes", () => {
    expect(
      missingReadSetVersions(
        "schedule.task.write",
        { task_id: "t1", parent_task_id: "t0", section_id: "s9" },
        [
          base("schedule.task", "t1"),
          base("schedule.task", "t0"),
          base("schedule.section", "s9"),
        ]
      )
    ).toStrictEqual([]);
  });

  test("a set short of the read-set names exactly what is missing", () => {
    expect(
      missingReadSetVersions(
        "schedule.task.write",
        { task_id: "t1", parent_task_id: "t0", section_id: "s9" },
        [base("schedule.task", "t1")]
      )
    ).toStrictEqual([
      {
        operation: "schedule.task.write",
        entity: "schedule.task",
        rowId: "t0",
      },
      {
        operation: "schedule.task.write",
        entity: "schedule.section",
        rowId: "s9",
      },
    ]);
  });

  test("a version of the right row under the wrong entity does not count", () => {
    expect(
      missingReadSetVersions("schedule.task.write", { task_id: "t1" }, [
        base("schedule.section", "t1"),
      ])
    ).toStrictEqual([
      {
        operation: "schedule.task.write",
        entity: "schedule.task",
        rowId: "t1",
      },
    ]);
  });

  test("an unknown operation demands nothing rather than refusing everything", () => {
    // A seat ahead of the gateway must not have every intent rejected; the
    // operation it names simply has no declaration here yet.
    expect(
      missingReadSetVersions("not.an.operation", { task_id: "t1" }, [])
    ).toStrictEqual([]);
  });
});
