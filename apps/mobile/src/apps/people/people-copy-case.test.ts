// D2 + S11 (#1015 Wave 3): sentence case everywhere, and one label table per
// enum. People printed the vault's own vocabulary as its interface copy in two
// places — the channel composer's chips and field label were the stored union
// (`phone`, `email`, `handle`) and Touch's Recent sub-lines were the stored
// touch kinds (`message`, `visit`) — while the Log screen wrote `Message` and
// `Met up` for the same events. This sweeps the tables, so a raw enum or a
// Title Case label cannot come back in unnoticed.

import { describe, expect, it } from "vitest";

import {
  FILTER_CHIPS,
  LOG_KINDS,
  ROUTE_TITLES,
  SECTIONS,
  STATUS,
  VERBS,
  channelKindLabel,
  touchKindLabel,
} from "@centraid/blueprints/apps/people/people-copy";

import { PEOPLE_BAND_DESTINATIONS } from "./people-band";

/** Capitalised for what they name, not by a casing system. */
const PROPER_NOUNS = new Set(["People", "Touch", "Search", "Trash", "Merge"]);

function titleCaseWords(label: string): string[] {
  return label.split("·").flatMap((clause) =>
    clause
      .trim()
      .split(/\s+/u)
      .slice(1)
      .filter(
        (word) =>
          /^[A-Z][a-z]/u.test(word) &&
          !PROPER_NOUNS.has(word.replace(/[.,:;?]$/u, ""))
      )
  );
}

describe("every People copy table is sentence case (D2, #1015)", () => {
  it.each([
    ["band destinations", PEOPLE_BAND_DESTINATIONS.map((d) => d.label)],
    ["pushed route titles", Object.values(ROUTE_TITLES)],
    ["filter chips", FILTER_CHIPS.map((chip) => chip.label)],
    ["sections", Object.values(SECTIONS)],
    ["verbs", Object.values(VERBS)],
    ["log kinds", [...LOG_KINDS]],
  ])("%s", (_where, labels) => {
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels)
      expect({ label, titleCase: titleCaseWords(label) }).toStrictEqual({
        label,
        titleCase: [],
      });
  });

  // people/findings #12: one event read `Met up` on the screen that recorded
  // it and `visit` on the screen that lists it.
  it("presents a stored kind through the one table, both spellings", () => {
    expect(channelKindLabel("phone")).toBe("Phone");
    expect(channelKindLabel("handle")).toBe("Handle");
    expect(touchKindLabel("visit")).toBe("Met up");
    expect(touchKindLabel("Met up")).toBe("Met up");
    expect(touchKindLabel("message")).toBe("Message");
    // A kind the vault holds and this table does not know is shown as itself.
    expect(channelKindLabel("carrier pigeon")).toBe("carrier pigeon");
    // Every word this seat writes reads back as itself.
    for (const kind of LOG_KINDS) expect(touchKindLabel(kind)).toBe(kind);
  });

  // people/findings #11: `1 of 7 match` was ungrammatical at every count.
  it("counts search results in a sentence", () => {
    expect(STATUS.searchResults(1, 7)).toBe("1 of 7 people");
    expect(STATUS.searchResults(0, 7)).toBe("No matches in 7 people");
    expect(STATUS.searchResults(1, 1)).toBe("1 of 1 person");
  });

  // people/findings #3: the place and the act shared one word, one screen
  // apart, the only difference a red border.
  it("does not spell the destructive act the same as the place", () => {
    expect(VERBS.trash).toBe("Trash");
    expect(VERBS.moveToTrash).toBe("Move to trash");
  });

  // people/findings #9: `★` was the chip's whole accessible name.
  it("names the starred filter with a word", () => {
    expect(FILTER_CHIPS.map((chip) => chip.label)).toContain("Starred");
    expect(FILTER_CHIPS.map((chip) => chip.label)).not.toContain("★");
  });
});
