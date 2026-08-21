import { describe, expect, it } from "vitest";

import {
  birthdaysOn,
  dayKeyOf,
  dueOn,
  ribbonLabel,
  shelfLabel,
  starredParties,
} from "./day-context";
import type { ContextRow } from "./day-context";

const PARTIES: ContextRow[] = [
  {
    party_id: "p-dana",
    kind: "person",
    display_name: "Dana Okafor",
    birth_date: "1988-03-12",
  },
  {
    party_id: "p-ruth",
    kind: "person",
    display_name: "Ruth Vance",
    birth_date: "--03-19",
  },
  {
    party_id: "p-owen",
    kind: "person",
    display_name: "Owen Pryce",
    birth_date: "1979-03-19",
  },
  { party_id: "org-1", kind: "org", display_name: "The surveyor" },
];

const TASKS: ContextRow[] = [
  {
    task_id: "t1",
    status: "needs-action",
    title: "Confirm the removals date",
    due_at: "2026-03-19",
  },
  {
    task_id: "t2",
    status: "in-process",
    title: "Cancel the standing order",
    due_at: "2026-03-19T17:00:00Z",
  },
  {
    task_id: "t3",
    status: "completed",
    title: "Ring the roofer",
    due_at: "2026-03-19",
  },
  { task_id: "t4", status: "needs-action", title: "Read the lease schedule" },
];

describe(birthdaysOn, () => {
  it("matches an annual MM-DD, whatever year the row stores", () => {
    expect(birthdaysOn("2026-03-12", PARTIES, new Set())).toStrictEqual([
      { id: "p-dana", inner: false, text: "Dana Okafor" },
    ]);
    expect(birthdaysOn("2031-03-12", PARTIES, new Set())).toHaveLength(1);
  });

  it("marks only a starred person as inner circle", () => {
    const facts = birthdaysOn("2026-03-12", PARTIES, new Set(["p-dana"]));
    expect(facts[0]?.inner).toBe(true);
    expect(
      birthdaysOn("2026-03-19", PARTIES, new Set(["p-dana"]))
    ).toStrictEqual([
      { id: "p-owen", inner: false, text: "Owen Pryce" },
      { id: "p-ruth", inner: false, text: "Ruth Vance" },
    ]);
  });

  it("leaves organisations and empty days alone", () => {
    expect(birthdaysOn("2026-03-13", PARTIES, new Set())).toStrictEqual([]);
  });
});

describe(ribbonLabel, () => {
  it("names one person and collapses several into a count", () => {
    expect(ribbonLabel(birthdaysOn("2026-03-12", PARTIES, new Set()))).toBe(
      "Dana Okafor"
    );
    expect(ribbonLabel(birthdaysOn("2026-03-19", PARTIES, new Set()))).toBe(
      "2 birthdays"
    );
    expect(ribbonLabel([])).toBe("");
  });
});

describe(dueOn, () => {
  it("keys open tasks to their day, in both stored shapes", () => {
    const rows = dueOn("2026-03-19", TASKS);
    expect(rows.map((row) => row.taskId)).toStrictEqual(["t1", "t2"]);
    expect(shelfLabel(rows.length)).toBe("2 due");
  });

  /** AN UNDATED TASK NEVER REACHES THE CALENDAR, in any code path. */
  it("has no day for a task with no due date", () => {
    for (const day of ["2026-03-18", "2026-03-19", "2026-03-20"])
      expect(dueOn(day, TASKS).some((row) => row.taskId === "t4")).toBe(false);
  });

  it("leaves a finished task off the shelf", () => {
    expect(dueOn("2026-03-19", TASKS).some((row) => row.taskId === "t3")).toBe(
      false
    );
  });
});

describe(starredParties, () => {
  const schemes: ContextRow[] = [
    { scheme_id: "s1", uri: "https://centraid.dev/schemes/flags" },
    { scheme_id: "s2", uri: "https://centraid.dev/schemes/tags" },
  ];
  const concepts: ContextRow[] = [
    { concept_id: "c1", scheme_id: "s1", notation: "starred" },
    { concept_id: "c2", scheme_id: "s1", notation: "archived" },
  ];
  const tags: ContextRow[] = [
    { target_type: "core.party", target_id: "p-dana", concept_id: "c1" },
    { target_type: "core.party", target_id: "p-ruth", concept_id: "c2" },
    { target_type: "core.event", target_id: "e-1", concept_id: "c1" },
  ];

  it("reads exactly the starred party edges", () => {
    expect([...starredParties(schemes, concepts, tags)]).toStrictEqual([
      "p-dana",
    ]);
  });

  it("says nobody rather than guessing when the vault has no flags", () => {
    expect(starredParties([], concepts, tags).size).toBe(0);
    expect(starredParties(schemes, [], tags).size).toBe(0);
  });
});

describe(dayKeyOf, () => {
  it("keys a local date without crossing a timezone", () => {
    expect(dayKeyOf(new Date(2026, 2, 1, 23, 30))).toBe("2026-03-01");
  });
});
