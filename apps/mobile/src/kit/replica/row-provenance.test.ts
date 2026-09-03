// The mounted plane's stamps, read once for every app (#880). Screens with no
// render harness on this seat are asserted from their sources: the ONE sentence
// must be IMPORTED, never re-typed, and reach JSX as element children, so a
// sighted member reads the refusal and not only a screen reader.
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  READ_ONLY_SOURCE_REASON,
  readOnlyRouteReason,
  refusedLabel,
  rowCanWrite,
  rowScopeLabels,
} from "./row-provenance";

const source = (relative: string): string =>
  fs.readFileSync(
    path.resolve(import.meta.dirname, "..", "..", relative),
    "utf8"
  );

const TASKS_SRC = source("apps/tasks/TasksHome.tsx");
const TASK_ROW_SRC = source("apps/tasks/TaskRow.tsx");
const AGENDA_SRC = source("apps/agenda/AgendaEvent.tsx");
const DRIVE_SRC = source("apps/docs/DriveList.tsx");
const PERSON_SRC = source("apps/people/PersonView.tsx");

describe(rowCanWrite, () => {
  it("reads the plane's own stamp", () => {
    expect(rowCanWrite({ __centraidCanWrite: false })).toBe(false);
    expect(rowCanWrite({ __centraidCanWrite: true })).toBe(true);
  });

  it("treats an UNSTAMPED row as writable — a missing stamp is not a refusal", () => {
    expect(rowCanWrite({ title: "A note" })).toBe(true);
    expect(rowCanWrite(undefined)).toBe(true);
    expect(rowCanWrite(null)).toBe(true);
  });
});

describe(rowScopeLabels, () => {
  it("returns every source carrying the row", () => {
    expect(
      rowScopeLabels({ __centraidScopeLabels: ["Home", "Studio"] })
    ).toStrictEqual(["Home", "Studio"]);
  });

  it("answers empty where the plane said nothing, and drops non-strings", () => {
    expect(rowScopeLabels({})).toStrictEqual([]);
    expect(
      rowScopeLabels({ __centraidScopeLabels: ["Home", 7] })
    ).toStrictEqual(["Home"]);
  });
});

describe(readOnlyRouteReason, () => {
  it("states the sentence when the whole context on screen is read-only", () => {
    expect(
      readOnlyRouteReason([{ canWrite: false }, { canWrite: false }])
    ).toBe(READ_ONLY_SOURCE_REASON);
  });

  it("says NOTHING over a mixed set — those rows each carry their own answer", () => {
    expect(
      readOnlyRouteReason([{ canWrite: false }, { canWrite: true }])
    ).toBeNull();
  });

  it("says nothing over an empty set — emptiness is not a refusal", () => {
    expect(readOnlyRouteReason([])).toBeNull();
  });
});

describe("one sentence for one truth", () => {
  it("names the vault AND what cannot be written into it", () => {
    expect(READ_ONLY_SOURCE_REASON).toBe(
      "This vault is read-only for you, so meaning cannot be written into it."
    );
  });

  it("keeps a refused verb to ONE text slot", () => {
    expect(refusedLabel("Star", READ_ONLY_SOURCE_REASON)).toBe(
      `Star — ${READ_ONLY_SOURCE_REASON}`
    );
  });
});

describe("stated once above the route, never one refusing button at a time", () => {
  const IMPORTS_REASON =
    /import\s*\{[^}]*READ_ONLY_SOURCE_REASON[^}]*\}\s*from\s*"\.\.\/\.\.\/kit\/replica\/row-provenance"/u;
  const RENDERS_REASON =
    /<Text[^>]*>\s*\{READ_ONLY_SOURCE_REASON\}\s*<\/Text>/u;

  it("imports the sentence in Tasks, Agenda and People — never re-typed", () => {
    expect(TASKS_SRC).toMatch(IMPORTS_REASON);
    expect(AGENDA_SRC).toMatch(IMPORTS_REASON);
    expect(PERSON_SRC).toMatch(IMPORTS_REASON);
  });

  it("renders it as visible children, not only as an accessibilityHint", () => {
    expect(TASKS_SRC).toMatch(RENDERS_REASON);
    expect(AGENDA_SRC).toMatch(RENDERS_REASON);
    expect(PERSON_SRC).toMatch(RENDERS_REASON);
  });

  it("still offers the hint too, on the controls it withholds", () => {
    expect(TASK_ROW_SRC).toMatch(
      /accessibilityHint=\{[^}]*READ_ONLY_SOURCE_REASON/u
    );
    expect(AGENDA_SRC).toMatch(
      /accessibilityHint=\{[^}]*READ_ONLY_SOURCE_REASON/u
    );
  });

  it("withholds the Tasks verbs off the row's own role rather than letting a tap throw", () => {
    expect(TASK_ROW_SRC).toMatch(/disabled=\{!writable\}/u);
    expect(TASK_ROW_SRC).toMatch(
      /\{\.\.\.\(writable && onPickUp \? \{ onLongPress: \(\) => onPickUp\(task\) \} : \{\}\)\}/u
    );
    expect(TASKS_SRC).toMatch(/rowCanWrite\(row\)/u);
  });

  it("lets the Docs drive state it once above the rows, off the same reader", () => {
    expect(DRIVE_SRC).toMatch(/readOnlyRouteReason\(docs\)/u);
    expect(DRIVE_SRC).toMatch(/\{readOnlyReason\}/u);
  });
});
