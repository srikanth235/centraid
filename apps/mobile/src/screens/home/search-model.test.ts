/**
 * Search overlay's pure grouping + empty-state logic (#708, mobile
 * close-out). No React/replica involved — see the module header for why.
 */
import { describe, expect, it } from "vitest";

import type { BlueprintSearchHit } from "./blueprint-search";
import {
  formatSearchMeta,
  groupSearchHits,
  selectSearchRecents,
  selectSuggestionChips,
} from "./search-model";
import type { RecentSourceRow } from "./search-model";

function hit(overrides: Partial<BlueprintSearchHit> = {}): BlueprintSearchHit {
  return {
    appId: "notes",
    appLabel: "Notes",
    appColor: "#123456",
    appIconKey: "Book",
    entity: "knowledge.note",
    kind: "note",
    id: "note-1",
    label: "Untitled",
    ...overrides,
  };
}

function recent(overrides: Partial<RecentSourceRow> = {}): RecentSourceRow {
  return {
    appId: "docs",
    appLabel: "Docs",
    appColor: "#abcdef",
    appIconKey: "Folder",
    kind: "doc",
    id: "doc-1",
    label: "Untitled",
    ...overrides,
  };
}

describe(groupSearchHits, () => {
  it("groups hits by app, in catalog order, and drops apps with no hits", () => {
    const groups = groupSearchHits([
      hit({ appId: "tally", appLabel: "Tally", kind: "expense", id: "e1" }),
      hit({ appId: "notes", id: "n1", label: "Trip notes" }),
      hit({ appId: "notes", id: "n2", label: "Trip journal" }),
    ]);

    expect(groups.map((group) => group.appId)).toStrictEqual([
      "notes",
      "tally",
    ]);
    const notesGroup = groups.find((group) => group.appId === "notes");
    expect(notesGroup?.hits).toHaveLength(2);
    expect(notesGroup?.appLabel).toBe("Notes");
  });

  it("returns no groups for an empty hit list", () => {
    expect(groupSearchHits([])).toStrictEqual([]);
  });

  it("never produces a Locker group — no target searches it", () => {
    const groups = groupSearchHits([hit({ appId: "locker" })]);
    expect(groups).toStrictEqual([]);
  });
});

describe(selectSearchRecents, () => {
  it("sorts newest meta first and caps at the limit", () => {
    const rows = [
      recent({ id: "a", meta: "2026-01-01T00:00:00.000Z" }),
      recent({ id: "b", meta: "2026-06-01T00:00:00.000Z" }),
      recent({ id: "c", meta: "2026-03-01T00:00:00.000Z" }),
    ];
    const recents = selectSearchRecents(rows, 2);
    expect(recents.map((row) => row.id)).toStrictEqual(["b", "c"]);
  });

  it("sorts rows with no meta after every timestamped row", () => {
    const rows = [
      recent({ id: "no-meta" }),
      recent({ id: "dated", meta: "2026-01-01T00:00:00.000Z" }),
    ];
    const recents = selectSearchRecents(rows);
    expect(recents.map((row) => row.id)).toStrictEqual(["dated", "no-meta"]);
  });
});

describe(formatSearchMeta, () => {
  it("formats an ISO instant as a short month + day", () => {
    // Host locale may put day before or after month ("Aug 3" vs "3 Aug").
    expect(formatSearchMeta("2026-08-03T12:00:00.000Z")).toMatch(
      /(?:Aug\s*3|3\s*Aug)/u
    );
  });

  it("returns undefined for missing or unparseable input", () => {
    expect(formatSearchMeta(undefined)).toBeUndefined();
    expect(formatSearchMeta("not-a-date")).toBeUndefined();
  });
});

describe(selectSuggestionChips, () => {
  it("dedupes case-insensitively and caps the count", () => {
    const chips = selectSuggestionChips(
      ["Jordan Lee", "jordan lee", "Grocery list", "", "  "],
      2
    );
    expect(chips).toStrictEqual(["Jordan Lee", "Grocery list"]);
  });

  it("keeps a handoff-shaped candidate set whole — short terms pass as-is", () => {
    // The v4 fixture row (.dc.html :6012): three short terms, one row.
    expect(
      selectSuggestionChips(["Pemberton", "right of way", "Ana"])
    ).toStrictEqual(["Pemberton", "right of way", "Ana"]);
  });

  it("derives a distinctive word from a long label instead of ellipsising", () => {
    const chips = selectSuggestionChips(
      ["Pemberton right of way survey notes for the north lot"],
      3
    );
    expect(chips).toStrictEqual(["Pemberton"]);
  });

  it("never emits an ellipsised fragment", () => {
    const chips = selectSuggestionChips(
      ["A vault-content title so long it must never be truncated for a chip"],
      3
    );
    for (const chip of chips) expect(chip).not.toContain("…");
  });

  it("drops a candidate with no usable word rather than truncating it", () => {
    // Every word exceeds the term cap — nothing searchable survives.
    expect(
      selectSuggestionChips(["Pneumonoultramicroscopicsilicovolcanoconiosis"])
    ).toStrictEqual([]);
  });

  it("caps the row by total characters — an overflowing term is dropped, a shorter later one still fits", () => {
    const chips = selectSuggestionChips(
      ["Pemberton", "right of way", "Reconciliation", "Ana"],
      3,
      16,
      24
    );
    // 9 + 12 = 21 used; "Reconciliation" (14) would blow the 24 budget and
    // is dropped, but "Ana" (3) still fits exactly.
    expect(chips).toStrictEqual(["Pemberton", "right of way", "Ana"]);
  });
});
