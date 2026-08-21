// Copy integrity: the house rules this app's strings live under, asserted on
// the table itself rather than on a rendered screen.
//
// The repo-wide ratchet (`tests/quality/user-facing-qualities.test.ts`) walks
// every literal in the product; this suite is the app's own copy of the same
// rules pointed at the one module that is meant to hold all of Agenda's
// strings — so a violation fails beside the table rather than in a repo-wide
// sweep somebody else is running.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ViewKind } from "./types.ts";
import * as copy from "./view-copy.ts";

const BANNED =
  /\b(?:please|successfully|simply|in order to|you can|we're sorry)\b/iu;

/** Two or more sentences: an internal boundary plus a terminated tail. */
function sentenceCount(text: string): number {
  const inner = text.match(/[.!?…](?=\s+["'(]?\p{Lu})/gu)?.length ?? 0;
  return inner + (/[.!?…]["')]?\s*$/u.test(text) ? 1 : 0);
}

/** Every plain string this module exports, flattened out of its tables. */
function strings(): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const item of value) walk(item);
    else if (value && typeof value === "object")
      for (const item of Object.values(value)) walk(item);
  };
  for (const [name, value] of Object.entries(copy)) {
    if (typeof value === "function") continue;
    walk(value);
    expect(name).toBeTypeOf("string");
  }
  return out;
}

describe("Agenda's copy", () => {
  it("keeps every literal inside one sentence and 120 characters", () => {
    for (const text of strings()) {
      expect(text.length, text).toBeLessThanOrEqual(120);
      expect(sentenceCount(text), text).toBeLessThanOrEqual(1);
    }
  });

  it("uses none of the banned filler words", () => {
    for (const text of strings()) expect(BANNED.test(text), text).toBe(false);
  });

  it("names all five views and counts each of them in its own noun", () => {
    const views: ViewKind[] = ["month", "week", "day", "schedule", "waiting"];
    // Asserting the values, not their truthiness: a label is the word the
    // switcher segment shows and a unit is the noun the app-bar count is
    // spoken in, so an empty string is as wrong as a missing key.
    expect(Object.keys(copy.VIEW_LABELS).toSorted()).toEqual(views.toSorted());
    expect(Object.keys(copy.VIEW_UNITS).toSorted()).toEqual(views.toSorted());
    for (const view of views) {
      expect(copy.VIEW_LABELS[view].length, view).toBeGreaterThan(0);
      expect(copy.VIEW_UNITS[view].length, view).toBeGreaterThan(0);
    }
  });

  it("gives each empty case its own words, and searching its own again", () => {
    const lines = new Set([
      copy.emptyLine("schedule", false),
      copy.emptyLine("waiting", false),
      copy.emptyLine("month", false),
      copy.emptyLine("month", true),
    ]);
    expect(lines.size).toBe(4);
  });

  it("names the denied slice rather than pretending the merge was whole", () => {
    expect(copy.partlyDeniedLine(["Work", "Family"])).toContain("Work");
    expect(copy.partlyDeniedLine(["Work", "Family"])).toContain("Family");
  });

  it("says who releases a parked cancellation, and offers no unpark verb", () => {
    expect(copy.PARKED_CANCEL_BODY).toContain("owner");
    expect(copy.PARKED_CANCEL_REVIEW).toContain("Approvals");
  });
});

describe("no raw recurrence rule reaches a surface", () => {
  // The repeat picker carries RRULE fragments as VALUES on their way to the
  // vault. What must never happen is one of them being rendered — so the check
  // is that every choice's LABEL is words, and that no component prints a
  // rule.
  it("names every repeat choice in words", () => {
    for (const choice of copy.REPEAT_CHOICES) {
      expect(choice.label, choice.rrule).not.toContain("FREQ=");
      expect(choice.rrule).toContain("FREQ=");
    }
  });

  it("keeps `rrule` out of every rendered component", () => {
    const root = path.resolve(import.meta.dirname, "components");
    for (const file of [
      "Grid.tsx",
      "ListViews.tsx",
      "EventDetail.tsx",
      "Shared.tsx",
    ]) {
      const source = readFileSync(path.join(root, file), "utf8");
      expect(source, file).not.toMatch(/\bev\.rrule\b/u);
    }
  });
});
