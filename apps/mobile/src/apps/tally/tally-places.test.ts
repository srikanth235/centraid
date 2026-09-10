// What a Tally route may no longer say about itself (#1015 Wave 2, audit B7).
//
// Both facts a surface used to write down — the band tab it lights and the
// place it descends from — are derived from its shelf here, so the sweep at
// the bottom is the real assertion: no Tally screen spells either one.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACTIVITY,
  EXPENSE,
  FRIEND,
  GROUP,
  GROUPS,
  RECEIPT,
  SETTLE,
  SPENDING,
  TRASH,
  WAITING,
} from "@centraid/blueprints/apps/tally/shelves";

import {
  isTallyPlace,
  tallyDestinationFor,
  tallyParentPlace,
} from "./tally-places";

describe(tallyDestinationFor, () => {
  it("lights the band tab a shelf sits under", () => {
    expect(tallyDestinationFor(null)).toBe("balances");
    expect(tallyDestinationFor(ACTIVITY)).toBe("activity");
    expect(tallyDestinationFor(GROUP)).toBe("groups");
    expect(tallyDestinationFor(FRIEND)).toBe("balances");
    expect(tallyDestinationFor(WAITING)).toBe("contrib");
  });

  it("lights none of the four for a More surface", () => {
    expect(tallyDestinationFor(SPENDING)).toBe("more");
    expect(tallyDestinationFor(TRASH)).toBe("more");
  });

  it("knows which shelves ARE places and which sit under one", () => {
    expect(isTallyPlace(GROUPS)).toBe(true);
    expect(isTallyPlace(GROUP)).toBe(false);
  });
});

describe(tallyParentPlace, () => {
  it("names the parent a pushed surface actually descends from", () => {
    expect(tallyParentPlace(GROUP).title).toBe("Groups");
    expect(tallyParentPlace(SETTLE).title).toBe("Balances");
    expect(tallyParentPlace(EXPENSE).title).toBe("Activity");
    // A receipt belongs to its expense, not to the tab the expense sits under.
    expect(tallyParentPlace(RECEIPT).title).toBe("Expense");
  });

  it("sends a More surface back to the app, which is where it came from", () => {
    expect(tallyParentPlace(TRASH).title).toBe("Tally");
  });
});

describe("the Tally tree", () => {
  const dir = import.meta.dirname;
  const sources = readdirSync(dir)
    .filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
    .map((name) => [name, readFileSync(path.join(dir, name), "utf8")] as const);

  it("has sources to sweep", () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it("writes down no band tab and no back target", () => {
    const spelled = sources.filter(([, source]) =>
      /\b(?:backTo|current)=["']/u.test(source)
    );
    expect(spelled.map(([name]) => name)).toStrictEqual([]);
  });

  it("roots every Tally surface in the frame, and the frame in a room", () => {
    const frame = readFileSync(path.join(dir, "TallyScreen.tsx"), "utf8");
    expect(frame).toContain("<AppPlace");
    expect(frame).toContain("<PushedPage");
    for (const [name, source] of sources) {
      if (!name.endsWith("Screen.tsx") || name === "TallyScreen.tsx") continue;
      expect([name, source.includes("<TallyScreen")]).toStrictEqual([
        name,
        true,
      ]);
    }
  });
});
