// How a row says WHEN, and what stands in its meta line (spec §5, §9).
//
// The clock is injected in every case here for the reason the module takes it
// as an argument: the midnight problem is a boundary problem, and a helper that
// read the wall clock for itself could be asserted on only one side of it.
import { describe, expect, it } from "vitest";

import {
  ageLabel,
  dayKey,
  daysBetween,
  dueLabel,
  isDateOnly,
  isOverdue,
  metaParts,
  monthName,
  priorityFromDigit,
  priorityLevel,
  timeOfDay,
  weekdayName,
} from "./format.ts";
import type { Task } from "./types.ts";

const NOW = "2026-08-21T09:00:00Z";

function task(patch: Partial<Task> = {}): Task {
  return {
    task_id: "t1",
    status: "needs-action",
    title: "Send the studio invoice",
    ...patch,
  };
}

describe("date-only against timed", () => {
  it("tells the two apart, which is what the midnight rule is made of", () => {
    expect(isDateOnly("2026-08-21")).toBe(true);
    expect(isDateOnly("2026-08-21T17:00:00Z")).toBe(false);
    expect(isDateOnly(null)).toBe(false);
  });

  it("renders a date-only task without a moment it does not have", () => {
    expect(dueLabel("2026-08-21", NOW)).toBe("today");
  });

  it("renders a timed task with the moment it does have", () => {
    expect(dueLabel("2026-08-21T17:00:00Z", NOW)).toBe("today, 17:00");
    expect(timeOfDay("2026-08-21T17:00:00Z")).toBe("17:00");
  });
});

describe("what a due phrase says", () => {
  it.each([
    ["2026-08-19", "2 days ago"],
    ["2026-08-20", "yesterday"],
    ["2026-08-21", "today"],
    ["2026-08-22", "tomorrow"],
    ["2026-08-25", "Tuesday"],
    ["2026-09-14", "14 Sep"],
  ])("reads %s as %s", (due, expected) => {
    expect(dueLabel(due, NOW)).toBe(expected);
  });

  it("says nothing at all for an undated task", () => {
    expect(dueLabel(null, NOW)).toBeNull();
  });

  it("is a plain phrase, never a countdown or a colour word", () => {
    expect(dueLabel("2026-08-19", NOW)).not.toMatch(/overdue|late|!/iu);
  });
});

describe("overdue", () => {
  it("is a fact about the clock, and reads from the live occurrence", () => {
    expect(isOverdue(task({ due_at: "2026-08-19" }), NOW)).toBe(true);
    expect(isOverdue(task({ due_at: "2026-08-21" }), NOW)).toBe(false);
    // A repeating task's live occurrence wins over the series' first due.
    expect(
      isOverdue(
        task({
          due_at: "2026-01-01",
          next_due: "2026-08-28",
          rrule: "FREQ=WEEKLY",
        }),
        NOW
      )
    ).toBe(false);
  });

  it("marks the due part for the attention tone and nothing else", () => {
    const parts = metaParts({ task: task({ due_at: "2026-08-19" }), now: NOW });
    expect(parts.filter((part) => part.attention)).toHaveLength(1);
    expect(parts.find((part) => part.attention)?.text).toBe("2 days ago");
  });
});

describe("the meta line", () => {
  it("renders the summariser's words, never a raw rule", () => {
    const parts = metaParts({
      task: task({
        due_at: "2026-08-21",
        rrule: "FREQ=WEEKLY;BYDAY=FR",
        recurrence_summary: "Every week on Friday",
        missed: 4,
        next_due: "2026-08-28",
      }),
      now: NOW,
    });
    const text = parts.map((part) => part.text).join(" · ");
    expect(text).toContain("Every week on Friday");
    expect(text).toContain("missed 4 · next is Friday");
    expect(text).not.toContain("FREQ=");
    expect(text).not.toContain("BYDAY");
  });

  it("says a family's progress in words rather than a badge", () => {
    const parts = metaParts({
      task: task({
        children: [task({ task_id: "c1" }), task({ task_id: "c2" })],
        done_children: 1,
      }),
      now: NOW,
    });
    expect(parts.map((part) => part.text)).toContain("1 of 2");
  });

  it("marks every number as numeric, so nothing reorders under RTL", () => {
    // Each numeric part is drawn with the tabular + `unicode-bidi: isolate`
    // class; the flag is what carries that to the row, so a part carrying a
    // count or a clock and NOT flagged is the defect this asserts against.
    const parts = metaParts({
      task: task({
        due_at: "2026-08-21T17:00:00Z",
        effort_min: 25,
        remind_before_min: 30,
      }),
      now: NOW,
    });
    const unmarked = parts.filter(
      (part) => /\d/u.test(part.text) && part.numeric !== true
    );
    expect(unmarked).toStrictEqual([]);
  });

  it("puts the project first and the tags after the facts", () => {
    const parts = metaParts({
      task: task({
        due_at: "2026-08-21",
        tags: [{ tag_id: "g1", label: "home" }],
      }),
      now: NOW,
      projectName: "Kitchen",
    });
    expect(parts[0]?.text).toBe("Kitchen");
    expect(parts.at(-1)?.text).toBe("#home");
  });
});

describe("the age signal", () => {
  it("is a fact, and only once a row has genuinely been sitting", () => {
    expect(ageLabel(task({ created_at: "2026-03-02" }), NOW)).toBe(
      "sitting since March"
    );
    expect(ageLabel(task({ created_at: "2026-08-01" }), NOW)).toBeNull();
    // A dated task is not sitting — it is scheduled.
    expect(
      ageLabel(task({ created_at: "2026-03-02", due_at: "2026-08-21" }), NOW)
    ).toBeNull();
  });
});

describe("the small conversions", () => {
  it("keeps a date-only civil key as written, and a timed value on the local day", () => {
    expect(dayKey("2026-08-21")).toBe("2026-08-21");
    const timed = "2026-08-21T17:00:00Z";
    const local = new Date(timed);
    const pad = (n: number): string => String(n).padStart(2, "0");
    expect(dayKey(timed)).toBe(
      `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`
    );
  });

  it("counts whole civil days in both directions", () => {
    expect(daysBetween("2026-08-21", "2026-08-28")).toBe(7);
    expect(daysBetween("2026-08-28", "2026-08-21")).toBe(-7);
  });

  it("names the weekday and the month a value lands on", () => {
    expect(weekdayName("2026-08-28")).toBe("Friday");
    expect(monthName("2026-03-02")).toBe("March");
  });

  it("maps the north-star scale onto the four chips, 0 meaning unset", () => {
    // Todoist stores 1 as the lowest set priority and 4 as the highest.
    // The editor's chips write the same numbers (Soon=1, Next=2, Now=3).
    expect(priorityLevel(undefined)).toBe(0);
    expect(priorityLevel(0)).toBe(0);
    expect(priorityLevel(1)).toBe(1);
    expect(priorityLevel(2)).toBe(2);
    expect(priorityLevel(3)).toBe(3);
    expect(priorityLevel(4)).toBe(3);
  });

  it("maps Todoist digits 1–4 onto Now through unset", () => {
    expect(priorityFromDigit(1)).toBe(3);
    expect(priorityFromDigit(2)).toBe(2);
    expect(priorityFromDigit(3)).toBe(1);
    expect(priorityFromDigit(4)).toBe(0);
  });
});

describe("Today is the member's day, not UTC", () => {
  it("keys a timed due on the local calendar day even when UTC has already rolled", () => {
    // Named zone, not `process.env.TZ`: Node does not apply TZ after boot, so
    // a post-start mutation is a no-op on UTC CI and the member's day collapses
    // to the UTC prefix.
    const zone = "Pacific/Kiritimati";
    expect("2026-08-21T23:00:00Z".slice(0, 10)).toBe("2026-08-21");
    expect(dayKey("2026-08-21T23:00:00Z", zone)).toBe("2026-08-22");
    expect(dueLabel("2026-08-21", "2026-08-21T23:00:00Z", zone)).toBe(
      "yesterday"
    );
    expect(dueLabel("2026-08-22", "2026-08-21T23:00:00Z", zone)).toBe("today");
  });
});
