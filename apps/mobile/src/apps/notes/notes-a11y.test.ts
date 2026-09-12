// A11Y SWEEP (#1015 Wave 3). `scripts/lint-aria-labels.mjs` holds the web
// seats; nothing held the phone. Two of its rules are checkable from the
// source, and both were broken in this tree:
//
//  1. A label on a container that already renders the same words. VoiceOver
//     reads the label INSTEAD of the children, so `accessibilityLabel={
//     row.label}` over a row that shows `row.label` AND `row.meta` silently
//     drops the meta line.
//  2. A control with no name at all.
//
// The check is a grep because the defect is a MISSING or REDUNDANT prop, and
// a render can only exercise the screens a test already knows to build.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const sources = (): { file: string; text: string }[] =>
  readdirSync(__dirname)
    .filter((file) => file.endsWith(".tsx") && !file.includes(".test."))
    .map((file) => ({
      file,
      text: readFileSync(path.join(__dirname, file), "utf8"),
    }));

describe("Notes names its controls once (#1015 Wave 3)", () => {
  it("reads a tree to sweep", () => {
    expect(sources().length).toBeGreaterThan(0);
  });

  // The six sites this closed. `SeatList` REQUIRES a name, and Notes was
  // handing it the rail's whole explanatory caption — the sentence the screen
  // already draws underneath it — so the rotor said a paragraph and the
  // member heard it twice. A list is NAMED (`NOTES_LIST_NAMES`), never
  // captioned. The other three were `Pressable`s labelled with the very word
  // inside them ("New notebook", "Open the camera", the More row's label).
  it("SABOTAGE: no list is labelled with the caption it already draws", () => {
    for (const { file, text } of sources())
      for (const rail of ["RAIL_NOTEBOOKS", "RAIL_TAGS", "TRASH_STATUS"])
        expect({
          file,
          redundant: text.includes(`accessibilityLabel={${rail}}`),
        }).toStrictEqual({ file, redundant: false });
  });

  it("SABOTAGE: no control is labelled with a literal it also renders", () => {
    for (const { file, text } of sources()) {
      const labels = [
        ...text.matchAll(/accessibilityLabel="(?<label>[^"]+)"/gu),
      ].map((match) => match.groups!["label"]!);
      for (const label of labels) {
        // The label may only repeat visible words when it ADDS something —
        // "Note title" over a bare field, never "Open the camera" over a
        // button that says "Open the camera".
        const drawn = new RegExp(`>\\s*${label}\\s*<`, "u").test(text);
        expect({ file, label, drawnVerbatim: drawn }).toStrictEqual({
          file,
          label,
          drawnVerbatim: false,
        });
      }
    }
  });

  // A row that IS the current version says so as state, not as loose text.
  it("names each list with what it is", () => {
    const places = readFileSync(
      path.join(__dirname, "NotesPlaces.tsx"),
      "utf8"
    );
    for (const key of ["notebooks", "tags", "trash"])
      expect(places).toContain(`accessibilityLabel={NOTES_LIST_NAMES.${key}}`);
  });

  it("exposes the version being read as a state", () => {
    const history = readFileSync(
      path.join(__dirname, "NotesHistory.tsx"),
      "utf8"
    );
    expect(history).toContain(
      "accessibilityState={{ selected: Boolean(version.current) }}"
    );
  });
});
