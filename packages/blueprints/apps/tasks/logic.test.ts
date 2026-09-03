import { describe, expect, it } from "vitest";

import { weekdayName } from "./format.ts";
import {
  absence,
  allGroups,
  anytimeGroups,
  awayDays,
  boardState,
  byDue,
  catchUpWrites,
  inboxGroup,
  landsToday,
  logbookGroups,
  nestTaskFamilies,
  reentryBuckets,
  remindingTasks,
  todayGroups,
  upcomingGroups,
  windowEnd,
} from "./logic.ts";
import type { Task } from "./types.ts";
import { REENTRY_BUCKETS } from "./view-copy.ts";

const NOW = "2026-08-21T09:00:00Z";

function task(patch: Partial<Task> & { task_id: string }): Task {
  return { status: "needs-action", title: patch.task_id, ...patch };
}

describe("an undated task never touches Today", () => {
  const undated = task({ task_id: "u1" });
  const dated = task({ task_id: "d1", due_at: "2026-08-21" });

  it("is answered once, as a predicate", () => {
    expect(landsToday(undated, NOW)).toBe(false);
    expect(landsToday(dated, NOW)).toBe(true);
  });

  it("keeps it out of Today's groups in every code path", () => {
    const groups = todayGroups([undated, dated], NOW);
    const ids = groups.flatMap((group) => group.rows.map((row) => row.task_id));
    expect(ids).toStrictEqual(["d1"]);
  });

  it("keeps it out of Upcoming too — Anytime is where it lives", () => {
    const upcoming = upcomingGroups([undated], NOW, weekdayName);
    expect(upcoming).toStrictEqual([]);
    const anytime = anytimeGroups([undated], () => "Inbox");
    expect(anytime[0]?.rows.map((row) => row.task_id)).toStrictEqual(["u1"]);
  });
});

describe("Today's groups", () => {
  const rows = [
    task({ task_id: "late", due_at: "2026-08-18" }),
    task({ task_id: "later", due_at: "2026-08-19" }),
    task({ task_id: "now", due_at: "2026-08-21T17:00:00Z" }),
    task({ task_id: "soon", due_at: "2026-08-25" }),
    task({ task_id: "closed", due_at: "2026-08-19", status: "completed" }),
  ];

  it("puts overdue first, with its own header and its own meta", () => {
    const groups = todayGroups(rows, NOW);
    expect(groups.map((group) => group.key)).toStrictEqual([
      "overdue",
      "today",
    ]);
    expect(groups[0]?.attention).toBe(true);
    expect(groups[0]?.meta).toBe("2 · nothing was deleted");
  });

  it("is the ONE group in the attention tone, and nothing counts elsewhere", () => {
    const groups = todayGroups(rows, NOW);
    expect(groups.filter((group) => group.attention)).toHaveLength(1);
    expect(groups[1]?.meta).toBeUndefined();
  });

  it("leaves a closed row out of both groups", () => {
    const ids = todayGroups(rows, NOW).flatMap((group) =>
      group.rows.map((row) => row.task_id)
    );
    expect(ids).not.toContain("closed");
  });

  it("sorts date-only before timed within one day", () => {
    const dateOnly = task({ task_id: "a", due_at: "2026-08-21" });
    const timed = task({ task_id: "b", due_at: "2026-08-21T09:30:00Z" });
    expect([timed, dateOnly].toSorted(byDue)[0]?.task_id).toBe("a");
  });
});

describe("a repeating task is one live occurrence", () => {
  const repeating = task({
    task_id: "r1",
    due_at: "2026-07-24",
    rrule: "FREQ=WEEKLY;BYDAY=FR",
    recurrence_summary: "Every week on Friday",
    missed: 4,
    next_due: "2026-08-28",
  });

  it("renders as ONE row, never four copies", () => {
    const groups = upcomingGroups([repeating], NOW, weekdayName);
    expect(groups.flatMap((group) => group.rows)).toHaveLength(1);
  });

  it("groups on the live occurrence rather than the series' first due", () => {
    const groups = upcomingGroups([repeating], NOW, weekdayName);
    expect(groups[0]?.key).toBe("2026-08-28");
    expect(groups[0]?.label).toBe("Friday");
  });

  it("puts every repeating row in exactly one Catch-up bucket", () => {
    const buckets = reentryBuckets(
      [repeating, task({ task_id: "d", due_at: "2026-08-01" })],
      NOW,
      REENTRY_BUCKETS
    );
    const ids = buckets.flatMap((bucket) =>
      bucket.rows.map((row) => row.task_id)
    );
    expect(ids).toStrictEqual([...new Set(ids)]);
    expect(
      buckets.find((bucket) => bucket.key === "repeating")?.rows
    ).toHaveLength(1);
  });
});

describe("Catch up", () => {
  const rows = [
    task({ task_id: "d1", due_at: "2026-08-01" }),
    task({ task_id: "r1", due_at: "2026-07-01", rrule: "FREQ=DAILY" }),
    task({ task_id: "s1", created_at: "2026-03-02" }),
    task({ task_id: "fresh", created_at: "2026-08-15" }),
  ];

  it("measures the absence from the oldest thing that came due", () => {
    expect(awayDays(rows, NOW)).toBe(51);
    expect(absence(rows, NOW)).toStrictEqual({ days: 51, due: 2 });
  });

  it("names no absence for a two-day pile — that is a Tuesday", () => {
    expect(
      absence([task({ task_id: "x", due_at: "2026-08-20" })], NOW)
    ).toBeNull();
  });

  it("buckets the pile three ways, each with one bulk verb", () => {
    const buckets = reentryBuckets(rows, NOW, REENTRY_BUCKETS);
    expect(buckets.map((bucket) => bucket.key)).toStrictEqual([
      "dated",
      "repeating",
      "sitting",
    ]);
    for (const bucket of buckets) expect(bucket.verb.length).toBeGreaterThan(0);
    expect(buckets[2]?.rows.map((row) => row.task_id)).toStrictEqual(["s1"]);
  });

  it("Release all cancels the someday pile instead of dating it into Today", () => {
    const writes = catchUpWrites("sitting", [rows[2]!], "2026-08-21");
    expect(writes).toStrictEqual([
      {
        action: "set-status",
        input: { task_id: "s1", status: "cancelled" },
      },
    ]);
    expect(writes.some((write) => "due_at" in write.input)).toBe(false);
  });
});

describe("completing a parent leaves unfinished subtasks visible", () => {
  function family(rows: readonly Task[]): { open: Task[]; logbook: Task[] } {
    return nestTaskFamilies(rows, (row, children) => ({ ...row, children }));
  }

  it("promotes an unfinished child when its parent is completed", () => {
    const nested = family([
      task({ task_id: "p", status: "completed", completed_at: NOW }),
      task({ task_id: "c", parent_task_id: "p" }),
    ]);
    expect(nested.open.map((row) => row.task_id)).toStrictEqual(["c"]);
    expect(nested.logbook.map((row) => row.task_id)).toStrictEqual(["p"]);
    expect(
      nested.logbook[0]?.children?.map((row) => row.task_id)
    ).toStrictEqual([]);
  });

  it("promotes an unfinished child when its parent is released", () => {
    const nested = family([
      task({ task_id: "p", status: "cancelled", completed_at: NOW }),
      task({ task_id: "open", parent_task_id: "p" }),
      task({
        task_id: "done",
        parent_task_id: "p",
        status: "completed",
        completed_at: NOW,
      }),
    ]);
    expect(nested.open.map((row) => row.task_id)).toStrictEqual(["open"]);
    expect(
      nested.logbook[0]?.children?.map((row) => row.task_id)
    ).toStrictEqual(["done"]);
  });

  it("keeps unfinished children nested under an open parent", () => {
    const nested = family([
      task({ task_id: "p" }),
      task({ task_id: "c", parent_task_id: "p" }),
    ]);
    expect(nested.open.map((row) => row.task_id)).toStrictEqual(["p"]);
    expect(nested.open[0]?.children?.map((row) => row.task_id)).toStrictEqual([
      "c",
    ]);
  });
});

describe("the other lenses", () => {
  const rows = [
    task({ task_id: "a", due_at: "2026-08-21" }),
    task({ task_id: "b" }),
    task({ task_id: "c", project_id: "p1" }),
  ];

  it("splits All two ways and no third", () => {
    expect(allGroups(rows).map((group) => group.key)).toStrictEqual([
      "dated",
      "undated",
    ]);
  });

  it("shows the Inbox as unfiled rows with a meta that counts at nobody", () => {
    const group = inboxGroup(rows);
    expect(group.rows.map((row) => row.task_id)).toStrictEqual(["a", "b"]);
    expect(group.meta).toBe("2 · nothing is counting at you");
  });

  it("groups Anytime by where a task belongs", () => {
    const groups = anytimeGroups(rows, (id) => (id ? "Kitchen" : "Inbox"));
    expect(groups.map((group) => group.label)).toStrictEqual([
      "Inbox",
      "Kitchen",
    ]);
  });
});

describe("the state a screen may claim", () => {
  const base = { denied: false, logbook: [], projects: [], now: NOW };

  it("claims nothing before a read has landed", () => {
    expect(boardState({ ...base, loaded: false, rows: [] })).toBe("loading");
  });

  it("puts a denial above every quiet", () => {
    expect(boardState({ ...base, loaded: true, denied: true, rows: [] })).toBe(
      "denied"
    );
  });

  it("says day one only when the vault holds nothing at all", () => {
    expect(boardState({ ...base, loaded: true, rows: [] })).toBe("day-one");
    expect(
      boardState({ ...base, loaded: true, rows: [], projects: [{}] })
    ).toBe("nothing-scheduled");
  });

  it("tells the earned quiet apart from the neutral one", () => {
    expect(
      boardState({
        ...base,
        loaded: true,
        rows: [task({ task_id: "u" })],
        logbook: [
          task({ task_id: "x", status: "completed", completed_at: NOW }),
        ],
      })
    ).toBe("all-done");
    expect(
      boardState({
        ...base,
        loaded: true,
        rows: [task({ task_id: "u" })],
        projects: [{}],
      })
    ).toBe("nothing-scheduled");
  });

  it("is live whenever anything is actually due today", () => {
    expect(
      boardState({
        ...base,
        loaded: true,
        rows: [task({ task_id: "a", due_at: "2026-08-21" })],
      })
    ).toBe("live");
  });
});

describe("a bounded window says so", () => {
  const data = {
    open: [task({ task_id: "a" })],
    counts: { open: 214 },
  };

  it("stays silent when the vault answered with everything", () => {
    expect(windowEnd(data, false)).toBeNull();
  });

  it("names both numbers when it did not", () => {
    expect(windowEnd(data, true)).toStrictEqual({ shown: 1, total: 214 });
  });
});

describe("the Logbook holds two outcomes", () => {
  const rows = [
    task({ task_id: "open" }),
    task({
      task_id: "done",
      status: "completed",
      completed_at: "2026-08-20T10:00:00Z",
    }),
    task({
      task_id: "older",
      status: "completed",
      completed_at: "2026-08-18T10:00:00Z",
    }),
    task({
      task_id: "released",
      status: "cancelled",
      completed_at: "2026-08-19T10:00:00Z",
    }),
  ];

  it("separates done from won't do, and keeps the open board out", () => {
    const groups = logbookGroups(rows);
    expect(groups.map((group) => group.key)).toStrictEqual(["done", "wont-do"]);
    expect(groups[0]?.rows.map((row) => row.task_id)).toStrictEqual([
      "done",
      "older",
    ]);
    expect(groups[1]?.rows.map((row) => row.task_id)).toStrictEqual([
      "released",
    ]);
  });

  it("names no group it has no rows for", () => {
    expect(logbookGroups([task({ task_id: "open" })])).toStrictEqual([]);
  });
});

describe("a reminder needs a moment to count back from", () => {
  it("keeps the rows that will actually reach a phone", () => {
    const rows = [
      task({ task_id: "undated", remind_before_min: 10 }),
      task({ task_id: "no-lead", due_at: "2026-08-22" }),
      task({ task_id: "reaches", due_at: "2026-08-22", remind_before_min: 10 }),
      task({
        task_id: "closed",
        status: "completed",
        due_at: "2026-08-22",
        remind_before_min: 10,
      }),
    ];
    expect(remindingTasks(rows).map((row) => row.task_id)).toStrictEqual([
      "reaches",
    ]);
  });
});
