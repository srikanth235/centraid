// D2/S11 (#1015 Wave 3): sentence case EVERYWHERE, and the noun in every
// outcome. Tasks shouted two words at the member — `VAULT_MARKER` was the
// literal string "HOUSE", and the priority marks rode an eyebrow beside it —
// so the shout was written into the WORD rather than left to the type ramp,
// and it was uppercase wherever the string landed.

import { describe, expect, it } from "vitest";

import {
  AREAS,
  DENIED,
  DONE,
  EFFORT_CHIPS,
  LENSES,
  NEW_PROJECT,
  PRIORITY_CHIPS,
  QUICK_ADD,
  REOPEN,
  SORT_LABELS,
  TASK_DONE,
  UNDO,
  VAULT_MARKER,
  WONT_DO,
  doneNext,
} from "@centraid/blueprints/apps/tasks/view-copy";

import { titleCaseWords } from "../../kit/copy-case";
import { TASKS_BAND_DESTINATIONS, TASKS_MORE_ROWS } from "./tasks-band";
import { checkboxLabel } from "./tasks-row-model";

/**
 * Capitalised for what they name: the app's own places, the vaults a task can
 * live in, and the areas a project is filed under.
 */
const PROPER_NOUNS = new Set([
  "Tasks",
  "Today",
  "Upcoming",
  "Inbox",
  "Logbook",
  "Projects",
  "Project",
  "House",
  "Home",
  "Work",
  "Mine",
  "More",
  "Search",
  "None",
  "Soon",
  "Next",
  "Now",
  "Done",
  "Name",
  "Priority",
  "Manual",
  "Reopen",
  "Undo",
  // Weekdays name a day, not a system.
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
]);

describe("every Tasks copy table is sentence case (D2, #1015)", () => {
  it.each([
    ["band destinations", TASKS_BAND_DESTINATIONS.map((d) => d.label)],
    ["More sheet rows", TASKS_MORE_ROWS.map((row) => row.label)],
    ["the priority chips", [...PRIORITY_CHIPS]],
    ["the effort chips", [...EFFORT_CHIPS]],
    ["the lenses", LENSES.map((lens) => lens.label)],
    ["the sort toggle", Object.values(SORT_LABELS)],
    ["the areas", [...AREAS]],
    ["the new-project form", Object.values(NEW_PROJECT)],
    ["the outcomes", [DONE, WONT_DO, UNDO, REOPEN, TASK_DONE, VAULT_MARKER]],
    ["the denial", [DENIED.title, DENIED.bodyA, DENIED.bodyB]],
    ["quick add", Object.values(QUICK_ADD)],
  ])("%s", (_where, labels) => {
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels)
      expect({
        label,
        titleCase: titleCaseWords(label, PROPER_NOUNS),
      }).toStrictEqual({ label, titleCase: [] });
  });

  // SABOTAGE: the shout belongs to the type ramp, never to the string. An
  // ALL-CAPS literal is uppercase in every register it is ever reused in.
  it("SABOTAGE: no copy table shouts in its own letters", () => {
    const shouted = [
      ...PRIORITY_CHIPS,
      ...EFFORT_CHIPS,
      ...AREAS,
      VAULT_MARKER,
      DONE,
      WONT_DO,
      TASK_DONE,
    ].filter((label) => /^[A-Z]{2,}$/u.test(label));
    expect(shouted).toStrictEqual([]);
  });
});

describe("Tasks says the noun (#1015 S11)", () => {
  // "Done" on a status line of its own is a fact about nothing.
  it("names what was checked off", () => {
    expect(TASK_DONE).toBe("Task done");
    expect(doneNext("Tuesday")).toBe("Task done · the next one is Tuesday");
    // The group head keeps the bare word: it heads a list of them.
    expect(DONE).toBe("Done");
  });

  // Every effort chip carries its unit (tasks/findings#19).
  it("says what an effort counts", () => {
    for (const chip of EFFORT_CHIPS.slice(1))
      expect({ chip, unit: /\b(?:min|hour)\b/u.test(chip) }).toStrictEqual({
        chip,
        unit: true,
      });
  });

  // Two targets on one row, two names (tasks/findings#23).
  it("names the box by the act, not by the task", () => {
    expect(checkboxLabel("Call the roofer", false)).toBe(
      "Mark Call the roofer done"
    );
    expect(checkboxLabel("Call the roofer", true)).toBe(
      "Reopen Call the roofer"
    );
  });
});
