import { describe, expect, it } from "vitest";

import {
  ALL_LAYERS_ON,
  dueCountFor,
  dueTasksFor,
  hasAnyContext,
  NO_DAY_CONTEXT,
  ribbonLabel,
  ribbonsFor,
  shelfLabel,
} from "./day-context.ts";
import type { DayContextData, LayerState } from "./day-context.ts";
import { createMemberPrefs } from "./member-prefs.ts";

const DATA: DayContextData = {
  birthdays: [
    { party_id: "p1", name: "Dana Okafor", month: 3, day: 12, tier: "inner" },
    { party_id: "p2", name: "Ruth Vance", month: 3, day: 19, tier: "outer" },
    { party_id: "p3", name: "Owen Pryce", month: 3, day: 19, tier: "outer" },
    { party_id: "p4", name: "Ana Whitcombe", month: 3, day: 19, tier: "inner" },
  ],
  due: [
    {
      day: "2026-03-10",
      count: 1,
      tasks: [{ task_id: "t1", title: "Send the surveyor your questions" }],
    },
    {
      day: "2026-03-19",
      count: 4,
      tasks: [
        { task_id: "t2", title: "Confirm the removals date" },
        { task_id: "t3", title: "Cancel the standing order" },
      ],
    },
  ],
  holidays: [{ day: "2026-03-06", name: "Commonwealth Day" }],
};

const OFF = (over: Partial<LayerState>): LayerState => ({
  ...ALL_LAYERS_ON,
  ...over,
});

describe("ribbonsFor", () => {
  it("keys a birthday by its month and day, whatever the year", () => {
    const facts = ribbonsFor("2026-03-12", DATA, ALL_LAYERS_ON);
    expect(facts).toEqual([
      { kind: "birthday", id: "p1", text: "Dana Okafor", inner: true },
    ]);
    // The same birthday, a year later — the fact carries no year.
    expect(ribbonsFor("2027-03-12", DATA, ALL_LAYERS_ON)).toHaveLength(1);
  });

  it("puts a holiday on its exact day and nothing else", () => {
    expect(ribbonsFor("2026-03-06", DATA, ALL_LAYERS_ON)).toEqual([
      { kind: "holiday", id: "2026-03-06", text: "Commonwealth Day" },
    ]);
    expect(ribbonsFor("2027-03-06", DATA, ALL_LAYERS_ON)).toEqual([]);
  });

  it("draws nothing on a day nothing lands on", () => {
    expect(ribbonsFor("2026-03-13", DATA, ALL_LAYERS_ON)).toEqual([]);
  });

  it("removes a layer's facts when the layer is off, and nothing else", () => {
    expect(ribbonsFor("2026-03-12", DATA, OFF({ bdays: false }))).toEqual([]);
    // The holiday layer is untouched by the birthday switch.
    expect(ribbonsFor("2026-03-06", DATA, OFF({ bdays: false }))).toHaveLength(
      1
    );
    expect(ribbonsFor("2026-03-06", DATA, OFF({ hols: false }))).toEqual([]);
  });
});

describe("ribbonLabel", () => {
  it("says the one fact by name", () => {
    expect(ribbonLabel(ribbonsFor("2026-03-12", DATA, ALL_LAYERS_ON))).toBe(
      "Dana Okafor"
    );
  });

  it("collapses several birthdays into a count", () => {
    expect(ribbonLabel(ribbonsFor("2026-03-19", DATA, ALL_LAYERS_ON))).toBe(
      "3 birthdays"
    );
  });

  it("collapses a mixed day into dates rather than claiming birthdays", () => {
    const mixed: DayContextData = {
      ...DATA,
      holidays: [{ day: "2026-03-19", name: "Clocks go forward" }],
    };
    expect(ribbonLabel(ribbonsFor("2026-03-19", mixed, ALL_LAYERS_ON))).toBe(
      "4 dates"
    );
  });

  it("says nothing at all about a day with no facts", () => {
    expect(ribbonLabel([])).toBe("");
  });
});

describe("the due shelf", () => {
  it("counts a day from the projection, not from a zero-filled histogram", () => {
    expect(dueCountFor("2026-03-19", DATA, ALL_LAYERS_ON)).toBe(4);
    expect(dueCountFor("2026-03-11", DATA, ALL_LAYERS_ON)).toBe(0);
  });

  it("says the true count even when it lists fewer rows", () => {
    expect(shelfLabel(dueCountFor("2026-03-19", DATA, ALL_LAYERS_ON))).toBe(
      "4 due"
    );
    expect(dueTasksFor("2026-03-19", DATA, ALL_LAYERS_ON)).toHaveLength(2);
  });

  it("empties with its layer — the shelf goes, the ribbons stay", () => {
    const layers = OFF({ due: false });
    expect(dueCountFor("2026-03-19", DATA, layers)).toBe(0);
    expect(dueTasksFor("2026-03-19", DATA, layers)).toEqual([]);
    expect(ribbonsFor("2026-03-19", DATA, layers)).toHaveLength(3);
  });

  /**
   * AN UNDATED TASK NEVER APPEARS ON THE CALENDAR IN ANY CODE PATH. The
   * projection can only key a task to a day by its `due_at`, so an undated one
   * has no day to be keyed to — asserted here as the property the shelf
   * depends on rather than left implicit in the query.
   */
  it("has no day for a task with no due date", () => {
    const undated: DayContextData = { ...DATA, due: [] };
    for (const day of ["2026-03-10", "2026-03-19", "2026-03-31"])
      expect(dueCountFor(day, undated, ALL_LAYERS_ON)).toBe(0);
  });
});

describe("a read that did not land", () => {
  it("decorates nothing rather than breaking the rail", () => {
    expect(ribbonsFor("2026-03-19", NO_DAY_CONTEXT, ALL_LAYERS_ON)).toEqual([]);
    expect(dueCountFor("2026-03-19", NO_DAY_CONTEXT, ALL_LAYERS_ON)).toBe(0);
    expect(hasAnyContext(NO_DAY_CONTEXT)).toBe(false);
    expect(hasAnyContext(DATA)).toBe(true);
  });
});

describe("member prefs", () => {
  it("starts with every layer on and flips one at a time", () => {
    let changes = 0;
    const prefs = createMemberPrefs(() => {
      changes += 1;
    });
    expect(prefs.read().layers).toEqual(ALL_LAYERS_ON);
    prefs.toggleLayer("due");
    expect(prefs.read().layers).toEqual({
      bdays: true,
      due: false,
      hols: true,
    });
    expect(changes).toBe(1);
    prefs.toggleLayer("due");
    expect(prefs.read().layers.due).toBe(true);
  });
});
