// Copy integrity. The spec's table is the contract: these strings are
// SPECIFIED, not paraphrased, so a well-meaning rewrite has to fail here
// before it reaches a member's screen.
import { describe, expect, test } from "vitest";

import { BOOKS, JOURNAL, TRASH } from "./shelves.ts";
import {
  BACKLINKS_NOTE,
  CAPTURE_CUSTODY,
  CAPTURE_SCANNER,
  CAPTURE_WHAT,
  CONFLICT_INTACT,
  CONFLICT_KEPT,
  CONFLICT_TITLE,
  DELETE_NOTE_BODY,
  DELETE_NOTE_TITLE,
  DELETE_NOTEBOOK_KEPT,
  DENIED_ASK,
  DENIED_INTACT,
  DENIED_TITLE,
  EMPTY_DAY_ONE,
  JOURNAL_ROW,
  PENDING_CHIP,
  POWERBOX_FOOT,
  RAIL_NOTEBOOKS,
  RAIL_TAGS,
  RENAME_REFUSAL,
  SEARCH_EMPTY,
  TRASH_STATUS,
  UNFILED_NOTE,
  UNFILED_ROW,
  VOICE_AUDIO_READABLE,
  VOICE_NO_TRANSCRIPT_YET,
  anchoredFrom,
  deleteNotebookBody,
  deleteNotebookTitle,
  editorStatus,
  historyStatus,
  notebookDeleted,
  pendingStatus,
  searchNoMatch,
  shelfCopy,
  staleReplica,
  windowEnd,
} from "./view-copy.ts";

describe("the spec's copy table, verbatim", () => {
  test("the rail states the division in words", () => {
    expect(RAIL_NOTEBOOKS).toBe("Notebooks · where a note lives");
    expect(RAIL_TAGS).toBe("Tags · how a note is seen");
  });

  test("the two places in the spine carry their own sentences", () => {
    expect(`${UNFILED_ROW} · ${UNFILED_NOTE}`).toBe(
      "Unfiled · a note that was never filed still opens"
    );
    expect(JOURNAL_ROW).toBe(
      "Journal · written by People · kept apart from the rest"
    );
  });

  test("day one is one sentence", () => {
    expect(EMPTY_DAY_ONE).toBe("Write the first one.");
  });

  test("the two destructive confirms, and nothing else, reassure", () => {
    expect(DELETE_NOTE_TITLE).toBe("Move this note to trash?");
    expect(DELETE_NOTE_BODY).toBe(
      "It stays restorable for 30 days, with its links, tags and files."
    );
    expect(deleteNotebookTitle("Room by room")).toBe("Delete “Room by room”?");
    expect(`${deleteNotebookBody(31)} ${DELETE_NOTEBOOK_KEPT}`).toBe(
      "Its 31 notes become unfiled. Nothing is deleted with it."
    );
  });

  test("the vault's refusal is surfaced in the vault's own terms", () => {
    expect(RENAME_REFUSAL).toBe(
      "A notebook cannot share a name with its sibling"
    );
    expect(notebookDeleted(31)).toBe(
      "Notebook deleted · 31 notes are now unfiled"
    );
  });

  test("the standing status lines", () => {
    expect(TRASH_STATUS).toBe("Restorable for 30 days, then erased");
    expect(editorStatus(9)).toBe(
      "Every change is saved as you write · 9 versions kept"
    );
    expect(historyStatus(9)).toBe(
      "9 versions · restoring appends, it never rewrites"
    );
    expect(PENDING_CHIP).toBe("Saved on this device · queued for the vault");
    expect(pendingStatus(3)).toBe(
      "3 writes queued on this device · they settle when the gateway answers"
    );
  });

  test("the window says it is a window", () => {
    const total = new Intl.NumberFormat().format(5184);
    expect(windowEnd(60, 5184)).toBe(
      `60 of ${total} · this is a window, not the whole library`
    );
    expect(staleReplica("08:02")).toBe(
      "This replica last matched the vault at 08:02."
    );
  });

  test("conflict keeps both and says so in two flat sentences", () => {
    expect(CONFLICT_TITLE).toBe("Two devices changed this passage");
    expect(`${CONFLICT_KEPT} ${CONFLICT_INTACT}`).toBe(
      "Both are kept. Nothing was overwritten."
    );
  });

  test("search says what it searched", () => {
    expect(SEARCH_EMPTY).toBe("Type to search titles and bodies.");
    expect(searchNoMatch("boiler")).toBe("Nothing matches “boiler”.");
  });

  test("the powerbox names what it does not search", () => {
    expect(POWERBOX_FOOT).toBe(
      "Locker is not searched · a secret is never a link target"
    );
  });

  test("the backlinks block says what it actually is", () => {
    expect(BACKLINKS_NOTE).toBe(
      "The reverse query is not built yet · these two are the link rows read forwards"
    );
    expect(anchoredFrom("Q3 roadmap")).toBe(
      "anchored passage · linked from Q3 roadmap"
    );
  });

  test("the origin acts name where the content lands and who holds it", () => {
    expect(`${CAPTURE_SCANNER} ${CAPTURE_WHAT}`).toBe(
      "Docs owns the scanner. This is a photograph, attached to a note."
    );
    expect(CAPTURE_CUSTODY).toBe(
      "On this phone only until the gateway answers"
    );
    expect(`${VOICE_NO_TRANSCRIPT_YET} ${VOICE_AUDIO_READABLE}`).toBe(
      "No transcript yet. The audio is safe and readable as audio."
    );
  });

  test("the denial names the receipt and what is untouched", () => {
    expect(DENIED_TITLE).toBe("Notes cannot read this vault");
    expect(`${DENIED_ASK} ${DENIED_INTACT}`).toBe(
      "Ask the owner of this vault for access. Your notes, versions and receipts are untouched."
    );
  });
});

describe("no filler, anywhere", () => {
  const EVERY_STRING = [
    RAIL_NOTEBOOKS,
    RAIL_TAGS,
    UNFILED_NOTE,
    JOURNAL_ROW,
    EMPTY_DAY_ONE,
    DELETE_NOTE_TITLE,
    DELETE_NOTE_BODY,
    DELETE_NOTEBOOK_KEPT,
    RENAME_REFUSAL,
    TRASH_STATUS,
    PENDING_CHIP,
    CONFLICT_TITLE,
    CONFLICT_KEPT,
    CONFLICT_INTACT,
    SEARCH_EMPTY,
    POWERBOX_FOOT,
    BACKLINKS_NOTE,
    CAPTURE_SCANNER,
    CAPTURE_WHAT,
    CAPTURE_CUSTODY,
    VOICE_NO_TRANSCRIPT_YET,
    VOICE_AUDIO_READABLE,
    DENIED_TITLE,
    DENIED_ASK,
    DENIED_INTACT,
  ];

  test("none of the banned words reaches a screen", () => {
    for (const line of EVERY_STRING)
      expect(line).not.toMatch(
        /\b(?:please|successfully|simply|in order to|you can)\b/iu
      );
  });

  test("every literal stays inside the copy ratchet's own limits", () => {
    for (const line of EVERY_STRING)
      expect(line.length).toBeLessThanOrEqual(120);
  });
});

describe("the bar's title and unit per route", () => {
  test("a route is named once, by the bar", () => {
    expect(shelfCopy(null)).toStrictEqual({ title: "Notes", unit: "notes" });
    expect(shelfCopy(JOURNAL)).toStrictEqual({
      title: "Journal",
      unit: "entries",
    });
    expect(shelfCopy(BOOKS).unit).toBe("notebooks");
    expect(shelfCopy(TRASH).title).toBe("Trash");
  });

  test("a notebook carries its OWN name in the bar", () => {
    expect(shelfCopy("notebook:nb-7", "Room by room").title).toBe(
      "Room by room"
    );
  });
});
