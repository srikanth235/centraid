// D2 + S11 (#1015 Wave 3): sentence case everywhere, one label table per enum,
// and one apostrophe. Locker was the app that typed field labels and notes at
// the call site against its own stated rule (`locker-seat-copy.ts`'s header),
// named its root two different things, titled a route with the union of the
// two things it might be doing, and mixed typographic and straight apostrophes
// in one paragraph. This sweeps all four so none can come back in unnoticed.

import { describe, expect, it } from "vitest";

import { FIELD_NOTE } from "@centraid/blueprints/apps/locker/route-copy";
import { BAND_DESTINATIONS } from "@centraid/blueprints/apps/locker/shelves";
import {
  FIELD_LABEL,
  ROUTE_TITLE,
  TYPE_LABEL,
} from "@centraid/blueprints/apps/locker/view-copy";

import { LOCKER_MORE_ROWS } from "./locker-band";

/** Capitalised for what they name, not by a casing system. */
const PROPER_NOUNS = new Set([
  "Locker",
  "Items",
  "Review",
  "Generate",
  "Generator",
  "Search",
  "Import",
  "Export",
  "Trash",
  "Companion",
  "ID",
]);

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

describe("every Locker copy table is sentence case (D2, #1015)", () => {
  it.each([
    ["band destinations", BAND_DESTINATIONS.map((d) => d.label)],
    ["More sheet rows", LOCKER_MORE_ROWS.map((row) => row.label)],
    ["route titles", Object.values(ROUTE_TITLE)],
    ["field labels", Object.values(FIELD_LABEL)],
    ["item types", Object.values(TYPE_LABEL)],
  ])("%s", (_where, labels) => {
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels)
      expect({ label, titleCase: titleCaseWords(label) }).toStrictEqual({
        label,
        titleCase: [],
      });
  });

  // locker/findings #6: the root band tab said `Items` and the bar above it
  // said `Locker`; the composer said `Add / edit`, the union of both things.
  it("names the root what the tab that reached it is named", () => {
    const items = BAND_DESTINATIONS.find((d) => d.label === "Items");
    expect(items).toBeDefined();
    expect(ROUTE_TITLE.items).toBe("Items");
  });

  it("names the composer what it is doing, not both things it might do", () => {
    expect(ROUTE_TITLE.edit).toBe("Edit item");
    expect(ROUTE_TITLE.editNew).toBe("New item");
    expect(Object.values(ROUTE_TITLE)).not.toContain("Add / edit");
  });

  // locker/findings #9: five strings typed at the call site, which are exactly
  // the sentences that would drift between the desktop and the phone.
  it("holds the item screen's own labels and notes in the tables", () => {
    expect(FIELD_LABEL.compromised).toBe("Compromised");
    expect(FIELD_LABEL.url).toBe("Address");
    expect(FIELD_LABEL.notes).toBe("Memo");
    expect(FIELD_LABEL.strength).toBe("Strength");
    expect(FIELD_NOTE.otp_steps).toContain("Thirty-second steps");
    expect(FIELD_NOTE.strength).toContain("Review");
  });

  // locker/findings #10: `the vault’s, not Locker’s` two inches above `this
  // vault's key`, both visible at the rendered size.
  it("spells an apostrophe one way", () => {
    const every = [
      ...Object.values(ROUTE_TITLE),
      ...Object.values(FIELD_LABEL),
      ...Object.values(FIELD_NOTE),
      ...Object.values(TYPE_LABEL),
    ];
    for (const label of every) expect(label).not.toContain("’");
  });
});
