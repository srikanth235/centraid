// D2 (#1015 Wave 3, S11): sentence case EVERYWHERE, and one label table per
// enum. Tally's enums were written down twice — the nine categories lived in
// `draft-model.ts` for the composer's chips and again in `spending-model.ts`
// for the breakdown's rows, and the expense record printed neither, showing the
// vault's own key instead (`fun` under a chip that said `Fun`). This sweeps
// what a member reads off every Tally table so a second copy, or a Title Case
// label, cannot come back in unnoticed.

import { describe, expect, it } from "vitest";

import {
  CATEGORIES,
  categoryLabel,
} from "@centraid/blueprints/apps/tally/category-labels";
import {
  CURRENCY_CHIPS,
  EXPORT_FORMATS,
  EXPORT_RANGES,
  FIELD_KEYS,
  WHEN_CHIPS,
} from "@centraid/blueprints/apps/tally/compose-copy";
import { DIVISIONS } from "@centraid/blueprints/apps/tally/split-model";
import {
  VERBS,
  ledgerDayCount,
} from "@centraid/blueprints/apps/tally/view-copy";

import { TALLY_BAND_DESTINATIONS, TALLY_MORE_ROWS } from "./tally-band";

/**
 * Words capitalised for what they name, not by a casing system: the app's own
 * place names and the two file formats, which are acronyms. A label may open
 * with any word; only a mid-label capital that is not one of these is Title
 * Case.
 */
const PROPER_NOUNS = new Set([
  "Balances",
  "Activity",
  "Groups",
  "Waiting",
  "More",
  "Spending",
  "Search",
  "Trash",
  "Export",
  "Recurring",
  "CSV",
  "JSON",
  "USD",
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

describe("every Tally copy table is sentence case (D2, #1015)", () => {
  it.each([
    ["band destinations", TALLY_BAND_DESTINATIONS.map((d) => d.label)],
    ["More sheet rows", TALLY_MORE_ROWS.map((row) => row.label)],
    ["categories", CATEGORIES.map(([, label]) => label)],
    ["field keys", Object.values(FIELD_KEYS)],
    ["when chips", Object.values(WHEN_CHIPS)],
    ["currency chips", Object.values(CURRENCY_CHIPS)],
    ["export formats", EXPORT_FORMATS.map(([, label]) => label)],
    ["export ranges", EXPORT_RANGES.map(([, label]) => label)],
    ["divisions", DIVISIONS.map((d) => d.label)],
    ["verbs", Object.values(VERBS)],
  ])("%s", (_where, labels) => {
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels)
      expect({ label, titleCase: titleCaseWords(label) }).toStrictEqual({
        label,
        titleCase: [],
      });
  });

  // tally/findings #11: the composer said `Fun` and the saved record said
  // `fun`, because the record printed the vault's key and no table at all.
  it("presents a stored category through the one table", () => {
    expect(categoryLabel("fun")).toBe("Fun");
    expect(CATEGORIES).toHaveLength(9);
    // An unknown key is shown as itself: a fact the vault holds is not hidden.
    expect(categoryLabel("aeroplanes")).toBe("aeroplanes");
  });

  // tally/findings #10: `1 settlements`, and `6 expenses` over five expenses
  // and one settlement.
  it("counts a mixed day as the two things it holds, and never `1 …s`", () => {
    expect(ledgerDayCount(1, 1)).toBe("1 expense · 1 settlement");
    expect(ledgerDayCount(5, 0)).toBe("5 expenses");
    expect(ledgerDayCount(0, 1)).toBe("1 settlement");
  });
});
