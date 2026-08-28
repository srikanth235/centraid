// The detail place's projection, held to the rules the layout depends on: a
// field is absent when the row has no answer for it, the anchor exists only
// where a task repeats, and the two `organize-task` writes never drop the
// row's manual order.
import { describe, expect, it } from "vitest";

import {
  EFFORT_CHOICES,
  PROMOTION_AT,
  anchorHead,
  anchorOf,
  anchorWrite,
  effortIndex,
  lifecycleAct,
  projectNameOf,
  projectWrite,
  repeats,
  subtaskNotes,
  taskFields,
} from "./detail.ts";
import type { Task } from "./types.ts";
import {
  ANCHOR_CARDS,
  LIFECYCLE,
  PROMOTION_A,
  SUBTASK_CAP,
  homeVault,
} from "./view-copy.ts";

const NOW = "2026-08-28T09:00:00Z";

function task(overrides: Partial<Task> = {}): Task {
  return {
    task_id: "t1",
    status: "needs-action",
    title: "Water the fern",
    ...overrides,
  };
}

const keysOf = (input: Parameters<typeof taskFields>[0]): string[] =>
  taskFields(input).map((field) => field.key);

describe("the field projection", () => {
  it("draws no Time row for an undated task — there is no moment to state", () => {
    expect(keysOf({ task: task(), now: NOW })).not.toContain("time");
  });

  it("states the clock for an at-a-time task and the rule for a date-only one", () => {
    const timed = taskFields({
      task: task({ due_at: "2026-08-28T17:00:00Z" }),
      now: NOW,
    }).find((field) => field.key === "time");
    expect(timed?.value).toBe("17:00");
    expect(timed?.notes).toStrictEqual([]);

    const dateOnly = taskFields({
      task: task({ due_at: "2026-08-28" }),
      now: NOW,
    }).find((field) => field.key === "time");
    // No clock to show, so the row carries the rule instead of a fake moment.
    expect(dateOnly?.value).toBeNull();
    expect(dateOnly?.notes).toHaveLength(1);
  });

  it("draws the anchor ONLY where the task repeats", () => {
    expect(keysOf({ task: task(), now: NOW })).not.toContain("anchor");
    expect(
      keysOf({ task: task({ rrule: "FREQ=WEEKLY" }), now: NOW })
    ).toContain("anchor");
  });

  it("states the anchor in the words it was chosen by", () => {
    const rows = taskFields({
      task: task({ rrule: "FREQ=WEEKLY", recurrence_anchor: "completion" }),
      now: NOW,
    });
    expect(rows.find((field) => field.key === "anchor")?.value).toBe(
      ANCHOR_CARDS[1]?.head
    );
  });

  it("shows Missed only once a collapse has both a count and a next date", () => {
    expect(keysOf({ task: task({ missed: 4 }), now: NOW })).not.toContain(
      "missed"
    );
    expect(
      keysOf({
        task: task({ missed: 4, next_due: "2026-09-04" }),
        now: NOW,
      })
    ).toContain("missed");
  });

  it("keeps the home vault silent for a personal task", () => {
    expect(keysOf({ task: task(), now: NOW })).not.toContain("homeVault");
    expect(
      keysOf({
        task: task(),
        now: NOW,
        home: { vault: "House", who: "Ana" },
      })
    ).toContain("homeVault");
  });

  it("names an attachment row only when something is attached", () => {
    expect(keysOf({ task: task(), now: NOW })).not.toContain("attached");
  });

  it("orders the fields the spec lists them in", () => {
    const keys = keysOf({
      task: task({
        due_at: "2026-08-28T17:00:00Z",
        rrule: "FREQ=WEEKLY",
        recurrence_summary: "every Monday",
        missed: 2,
        next_due: "2026-09-04",
      }),
      now: NOW,
      home: { vault: "House", who: "Ana" },
    });
    expect(keys).toStrictEqual([
      "when",
      "time",
      "reminder",
      "repeats",
      "anchor",
      "missed",
      "priority",
      "effort",
      "project",
      "tags",
      "homeVault",
    ]);
  });
});

describe("the anchor", () => {
  it("defaults to the schedule — a bill's meaning, not a houseplant's", () => {
    expect(anchorOf(task({ rrule: "FREQ=WEEKLY" }))).toBe("scheduled");
    expect(anchorHead(task({ recurrence_anchor: "completion" }))).toBe(
      ANCHOR_CARDS[1]?.head
    );
    expect(repeats(task())).toBe(false);
  });

  it("carries the row's own sort order through, never a reset zero", () => {
    const write = anchorWrite(
      task({ sort_order: 12, recurrence_tz: "Europe/Berlin" }),
      "completion",
      "UTC"
    );
    expect(write).toStrictEqual({
      task_id: "t1",
      sort_order: 12,
      recurrence_anchor: "completion",
      recurrence_tz: "Europe/Berlin",
    });
  });

  it("falls back to the seat's zone only when the row carries none", () => {
    expect(anchorWrite(task(), "scheduled", "UTC")["recurrence_tz"]).toBe(
      "UTC"
    );
  });
});

describe("filing and the family", () => {
  it("clears the project explicitly rather than sending an empty id", () => {
    expect(projectWrite(task({ sort_order: 3 }), null)).toStrictEqual({
      task_id: "t1",
      sort_order: 3,
      clear_project: true,
    });
    expect(projectWrite(task(), "p1")["project_id"]).toBe("p1");
  });

  it("resolves the project's name, or nothing at all", () => {
    const projects = [{ project_id: "p1", name: "Kitchen", sort_order: 0 }];
    expect(projectNameOf(task({ project_id: "p1" }), projects)).toBe("Kitchen");
    expect(projectNameOf(task(), projects)).toBeNull();
  });

  it("states what the task has BECOME once the family outgrows the cap", () => {
    const small = task({ children: [task({ task_id: "c1" })] });
    expect(subtaskNotes(small)).toStrictEqual([SUBTASK_CAP]);
    const big = task({
      children: Array.from({ length: PROMOTION_AT }, (_, index) =>
        task({ task_id: `c${index}` })
      ),
    });
    expect(subtaskNotes(big)[0]).toBe(PROMOTION_A);
  });
});

describe("the lifecycle pair", () => {
  it("offers Start on an untouched row and Stop on a running one", () => {
    expect(lifecycleAct(task())).toStrictEqual({
      verb: LIFECYCLE.start,
      status: "in-process",
    });
    expect(lifecycleAct(task({ status: "in-process" }))).toStrictEqual({
      verb: LIFECYCLE.stop,
      status: "needs-action",
    });
  });

  it("offers neither on a closed row — there is no run to begin or halt", () => {
    expect(lifecycleAct(task({ status: "completed" }))).toBeNull();
    expect(lifecycleAct(task({ status: "cancelled" }))).toBeNull();
  });
});

describe("effort", () => {
  it("never offers a chip that would dispatch a no-op", () => {
    expect(EFFORT_CHOICES.every((choice) => choice.minutes >= 1)).toBe(true);
  });

  it("reads an unset effort as the first rung, not as a missing one", () => {
    expect(effortIndex(task())).toBe(0);
    expect(effortIndex(task({ effort_min: 25 }))).toBe(3);
  });
});

describe("the home vault line", () => {
  const homeOf = (home: { vault: string; who?: string }): string | null =>
    taskFields({ task: task(), now: NOW, home }).find(
      (field) => field.key === "homeVault"
    )?.value ?? null;

  it("names who else stands in the vault where the seat knows", () => {
    expect(homeOf({ vault: "House", who: "Ana" })).toBe(
      homeVault("House", "Ana")
    );
  });

  it("stops at the vault where it does not, rather than inventing a name", () => {
    expect(homeOf({ vault: "House" })).toBe("House");
  });
});
