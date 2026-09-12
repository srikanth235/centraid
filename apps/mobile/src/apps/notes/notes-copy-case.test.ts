// D2/S11 (#1015 Wave 3): sentence case EVERYWHERE, one label table per enum,
// and the noun in every outcome string. Notes keeps its copy in one pure
// module (`@centraid/blueprints/apps/notes/view-copy`) plus the band's own
// table, so this sweeps BOTH and the `.tsx` files that could smuggle a label
// past them.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ANCHOR_DEGRADED,
  BACKLINKS_NOTE,
  CAPTURE_CUSTODY,
  CAPTURE_SCANNER,
  CAPTURE_WHAT,
  DELETE_NOTEBOOK_KEPT,
  DELETE_NOTEBOOK_VERB,
  DELETE_NOTE_BODY,
  DELETE_NOTE_TITLE,
  DELETE_NOTE_VERB,
  DENIED_ASK,
  DENIED_INTACT,
  DENIED_TITLE,
  EMPTY_DAY_ONE,
  HISTORY_NEEDS_NOTE,
  JOURNAL_ROW,
  ORIGIN_SEAT_ONLY,
  PENDING_CHIP,
  RAIL_NOTEBOOKS,
  RAIL_TAGS,
  SEARCH_EMPTY,
  SEND_TO_TASKS,
  STALE_VERB,
  TRASH_STATUS,
  UNFILED_ROW,
  VOICE_AUDIO_READABLE,
  VOICE_NO_TRANSCRIPT_YET,
  WINDOW_END_VERB,
  notebookDeleted,
  sentToTasks,
} from "@centraid/blueprints/apps/notes/view-copy";

import { titleCaseWords } from "../../kit/copy-case";
import { readFailure } from "../../kit/rooms/read-failure";
import { NOTES_BAND_DESTINATIONS, NOTES_MORE_ROWS } from "./notes-band";
import {
  NOTES_EDITOR_TITLE,
  NOTES_EMPTY,
  NOTES_EMPTY_REST,
  NOTES_PIN,
  NOTES_WRITE_FAILED,
  NOTES_WRITE_REFUSED,
} from "./notes-copy";

/**
 * Capitalised because of what they name, not because of a casing system:
 * Notes' own place names, the apps it hands work to, and the vault's nouns.
 */
const PROPER_NOUNS = new Set([
  "Notes",
  "Notebooks",
  "Notebook",
  "Journal",
  "Search",
  "Tags",
  "Trash",
  "Capture",
  "Voice",
  "More",
  "Docs",
  "Tasks",
  "People",
  "Unfiled",
  "Both",
  "Nothing",
  "Your",
  "This",
  "Open",
  "Ask",
  "Type",
  "Write",
  "Pair",
  "Saved",
  "Restorable",
  "Version",
  "The",
  "Show",
  "Send",
  "On",
  "Two",
  "Move",
  "Delete",
  "Refresh",
  "It",
  "A",
]);

const SENTENCES: readonly (readonly [string, readonly string[]])[] = [
  ["band destinations", NOTES_BAND_DESTINATIONS.map((d) => d.label)],
  ["More sheet rows", NOTES_MORE_ROWS.map((row) => row.label)],
  [
    "More sheet captions",
    NOTES_MORE_ROWS.flatMap((row) => (row.meta ? [row.meta] : [])),
  ],
  [
    "the rails and the shelves",
    [RAIL_NOTEBOOKS, RAIL_TAGS, UNFILED_ROW, JOURNAL_ROW, TRASH_STATUS],
  ],
  [
    "the destructive confirms",
    [
      DELETE_NOTE_TITLE,
      DELETE_NOTE_BODY,
      DELETE_NOTE_VERB,
      DELETE_NOTEBOOK_KEPT,
      DELETE_NOTEBOOK_VERB,
    ],
  ],
  [
    "the outcomes",
    [notebookDeleted(0), notebookDeleted(3), sentToTasks("Roof quote")],
  ],
  [
    "the standing notices",
    [
      PENDING_CHIP,
      SEND_TO_TASKS,
      EMPTY_DAY_ONE,
      SEARCH_EMPTY,
      HISTORY_NEEDS_NOTE,
      WINDOW_END_VERB,
      STALE_VERB,
      BACKLINKS_NOTE,
      ANCHOR_DEGRADED,
      ORIGIN_SEAT_ONLY,
    ],
  ],
  [
    "capture and voice",
    [
      CAPTURE_SCANNER,
      CAPTURE_WHAT,
      CAPTURE_CUSTODY,
      VOICE_NO_TRANSCRIPT_YET,
      VOICE_AUDIO_READABLE,
    ],
  ],
  ["the denial", [DENIED_TITLE, DENIED_ASK, DENIED_INTACT]],
  [
    "the seat's own table",
    [
      ...Object.values(NOTES_EMPTY).flatMap((copy) => [copy.title, copy.body]),
      NOTES_EMPTY_REST.title,
      NOTES_EMPTY_REST.body,
      ...Object.values(NOTES_EDITOR_TITLE),
      ...Object.values(NOTES_PIN),
      NOTES_WRITE_REFUSED,
      NOTES_WRITE_FAILED,
    ],
  ],
];

describe("every Notes copy table is sentence case (D2, #1015)", () => {
  it.each(SENTENCES)("%s", (_where, labels) => {
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels)
      expect({
        label,
        titleCase: titleCaseWords(label, PROPER_NOUNS),
      }).toStrictEqual({ label, titleCase: [] });
  });
});

describe("Notes says the noun (#1015 S11/S14)", () => {
  // Copy is signage: "Deleted" is a fact about nothing.
  it("names what an outcome happened to", () => {
    expect(notebookDeleted(3).toLowerCase()).toContain("notebook");
    expect(sentToTasks("Roof quote")).toContain("Roof quote");
  });

  // S14: one error noun for the app, and the one retry word.
  it("names the app in both read failures, and retries in one word", () => {
    const failed = readFailure({
      failed: true,
      noun: "Notes",
      onRetry: () => undefined,
      unreachable: false,
    });
    expect(failed?.title).toBe("Notes could not be loaded");
    expect(failed?.retry.label).toBe("Try again");
    expect(
      readFailure({
        failed: false,
        noun: "Notes",
        onRetry: () => undefined,
        unreachable: true,
      })?.title
    ).toBe("Notes is not connected");
  });

  // S14, the whole point: `useSeatPages` hands the screen the exception's own
  // message, and `NotesHome` used to render it. The room's body may not be
  // fed `state.error` again.
  it("SABOTAGE: no Notes screen renders the read's exception", () => {
    const tsx = readdirSync(__dirname).filter(
      (file) => file.endsWith(".tsx") && !file.includes(".test.")
    );
    expect(tsx.length).toBeGreaterThan(0);
    for (const file of tsx) {
      const source = readFileSync(path.join(__dirname, file), "utf8");
      expect({
        file,
        leak: /state\.error\s*\?\?\s*""/u.test(source),
      }).toStrictEqual({ file, leak: false });
    }
  });
});
