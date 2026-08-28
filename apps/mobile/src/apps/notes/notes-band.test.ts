import { describe, expect, it } from "vitest";

// The band's rules, asserted without a renderer (#882).
//
// `notes-band.ts` is deliberately free of `react-native` imports so the CAP,
// the ownership latch, the shelf→tab mapping and the sheet's contents can be
// checked as values. What this file really guards is that the phone's band and
// the pointer seats' band are one table: the labels are imported from the
// blueprint, so a rename there that did not reach here fails as a mismatch
// rather than shipping as two vocabularies.
import {
  BAND_DESTINATIONS,
  BOOKS,
  CAPTURE,
  HISTORY,
  JOURNAL,
  MORE_SHELVES,
  NOTE,
  SEARCH,
  TAGS,
  TRASH,
  VOICE,
  notebookShelf,
} from "@centraid/blueprints/apps/notes/shelves";

import {
  NOTES_BAND_CAPSULE,
  NOTES_BAND_DESTINATIONS,
  NOTES_BAND_MAX_DESTINATIONS,
  NOTES_MORE_ROWS,
  NOTES_MORE_SHEET,
  notesBandKeyFor,
  resolveNotesBand,
} from "./notes-band";

describe("the band Notes claims", () => {
  it("sits at the cap: four places plus More", () => {
    expect(NOTES_BAND_DESTINATIONS).toHaveLength(NOTES_BAND_MAX_DESTINATIONS);
    expect(NOTES_BAND_DESTINATIONS.map((entry) => entry.key)).toStrictEqual([
      "library",
      "books",
      "journal",
      "search",
      "more",
    ]);
  });

  it("says the blueprint's own words, never a second spelling", () => {
    expect(
      NOTES_BAND_DESTINATIONS.slice(0, 4).map((entry) => entry.label)
    ).toStrictEqual(BAND_DESTINATIONS.map((entry) => entry.label));
  });

  it("gives every tab a label — a glyph alone is not a name", () => {
    for (const destination of NOTES_BAND_DESTINATIONS) {
      expect(destination.label.length).toBeGreaterThan(0);
      expect(destination.icon.length).toBeGreaterThan(0);
    }
  });

  it("keeps the capsule outside the tab group, always", () => {
    expect(NOTES_BAND_CAPSULE.inTabGroup).toBe(false);
    expect(NOTES_BAND_CAPSULE.edge).toBe("leading");
  });

  it("resolves to the app's band by default and the host's on request", () => {
    expect(resolveNotesBand("app")).toMatchObject({
      owner: "app",
      destinations: NOTES_BAND_DESTINATIONS,
    });
    expect(resolveNotesBand("host")).toStrictEqual({ owner: "host" });
  });
});

describe("which tab a shelf lights", () => {
  it("lights the four places the band carries", () => {
    expect(notesBandKeyFor(null)).toBe("library");
    expect(notesBandKeyFor(BOOKS)).toBe("books");
    expect(notesBandKeyFor(JOURNAL)).toBe("journal");
    expect(notesBandKeyFor(SEARCH)).toBe("search");
  });

  it("keeps a notebook inside Library — it is a filter, not a fifth place", () => {
    expect(notesBandKeyFor(notebookShelf("nb1"))).toBe("library");
  });

  it("lights More for every act, and for the sheet itself", () => {
    for (const shelf of [TAGS, TRASH, HISTORY, CAPTURE, VOICE, NOTE]) {
      expect(notesBandKeyFor(shelf)).toBe("more");
    }
    expect(notesBandKeyFor(NOTES_MORE_SHEET)).toBe("more");
  });
});

describe("the More sheet", () => {
  it("carries every act the band has no room for, in the spec's order", () => {
    expect(NOTES_MORE_ROWS.map((row) => row.shelf)).toStrictEqual([
      ...MORE_SHELVES,
    ]);
  });

  it("never repeats a band destination — a place is in one of the two", () => {
    const bandIds = new Set(BAND_DESTINATIONS.map((entry) => entry.id));
    for (const row of NOTES_MORE_ROWS) {
      expect(bandIds.has(String(row.shelf))).toBe(false);
    }
  });

  it("labels every row and gives it a glyph", () => {
    for (const row of NOTES_MORE_ROWS) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(row.icon.length).toBeGreaterThan(0);
    }
  });

  it("carries the trash countdown as the Trash row's own meta", () => {
    const trash = NOTES_MORE_ROWS.find((row) => row.shelf === TRASH);
    expect(trash?.meta).toBe("Restorable for 30 days, then erased");
  });
});
