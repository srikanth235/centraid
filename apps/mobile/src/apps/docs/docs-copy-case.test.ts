// D2/S11/S14 (#1015 Wave 3). Docs' copy was already sentence case; what it
// did not have was ONE PLACE for it. Five enums were spelled at the point of
// use inside `.tsx` files — custody, the upload's progress, the arrangement,
// a capability's state — so no sweep could see them, and four sites rendered
// the exception they caught onto a status line.

import { describe, expect, it } from "vitest";

import { titleCaseWords } from "../../kit/copy-case";
import { buildDocMenu } from "./doc-menu";
import type { DocMenuHandlers } from "./doc-menu";
import { DOCS_BAND_DESTINATIONS, DOCS_MORE_ROWS } from "./docs-band";
import {
  DOCS_ARRANGEMENT,
  DOCS_CAPABILITY_STATE,
  DOCS_CUSTODY,
  DOCS_HANDOVER_FAILED,
  DOCS_SEARCH_REFUSED,
  DOCS_TRASHED,
  DOCS_UPLOAD_STATE,
  SEARCH_IDLE,
  SHARED_CAPTION,
  SHARED_EMPTY_BODY,
  SHARED_EMPTY_TITLE,
  SHARED_TITLE,
  custodyLine,
  uploadStateLabel,
} from "./docs-copy";

/** Capitalised for what they name: Docs' places, and the vault's own nouns. */
const PROPER_NOUNS = new Set([
  "Docs",
  "Drive",
  "Folders",
  "Folder",
  "Starred",
  "Shared",
  "Trash",
  "Search",
  "More",
  "Due",
  "Storage",
  "Properties",
  "Details",
  "Versions",
  "List",
  "Grid",
  "Landed",
  "Waiting",
  "Uploading",
  "Missing",
  "Only",
  "Not",
  "On",
  "Off",
  "In",
  "This",
  "Nothing",
  "Sorted",
  "Type",
  "Document",
  "PDF",
  "IMG",
  "Try",
]);

const menuLabels = (): string[] => {
  const noop = (): void => undefined;
  const handlers: DocMenuHandlers = {
    share: noop,
    open: noop,
    download: noop,
    versions: noop,
    properties: noop,
    star: noop,
    unstar: noop,
    rename: noop,
    moveTo: noop,
    trash: noop,
    restore: noop,
  };
  const groups = buildDocMenu(
    { trashed: false, starred: false, folder_id: null },
    [{ folder_id: "c-tax", name: "Tax", parent_id: null }],
    handlers
  );
  return groups.flatMap((group) => group.rows.map((row) => row.label));
};

describe("every Docs copy table is sentence case (D2, #1015)", () => {
  it.each([
    ["band destinations", DOCS_BAND_DESTINATIONS.map((d) => d.label)],
    ["More sheet rows", DOCS_MORE_ROWS.map((row) => row.label)],
    ["the custody enum", Object.values(DOCS_CUSTODY)],
    ["the upload enum", Object.values(DOCS_UPLOAD_STATE)],
    ["the arrangement enum", Object.values(DOCS_ARRANGEMENT)],
    ["the capability enum", Object.values(DOCS_CAPABILITY_STATE)],
    [
      "the shared shelf",
      [SHARED_TITLE, SHARED_CAPTION, SHARED_EMPTY_TITLE, SHARED_EMPTY_BODY],
    ],
    [
      "the outcomes",
      [DOCS_TRASHED, DOCS_HANDOVER_FAILED, DOCS_SEARCH_REFUSED, SEARCH_IDLE],
    ],
  ])("%s", (_where, labels) => {
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels)
      expect({
        label,
        titleCase: titleCaseWords(label, PROPER_NOUNS),
      }).toStrictEqual({ label, titleCase: [] });
  });

  it("sweeps the row menu the same way", () => {
    const labels = menuLabels();
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels)
      expect({
        label,
        titleCase: titleCaseWords(label, PROPER_NOUNS),
      }).toStrictEqual({ label, titleCase: [] });
  });
});

describe("Docs says the noun, and never the engine's word (#1015 S11/S14)", () => {
  it("names what a status happened to", () => {
    expect(DOCS_TRASHED).toContain("Document");
    expect(DOCS_HANDOVER_FAILED).toContain("document");
  });

  // SABOTAGE: an enum value this seat has never met still gets a sentence,
  // and never the raw value.
  it("SABOTAGE: an unknown enum value is still a sentence", () => {
    for (const raw of ["glorped", "", null, undefined])
      expect(custodyLine(raw)).toBe(DOCS_CUSTODY["unswept"]);
    expect(uploadStateLabel("exploded")).toBe(DOCS_UPLOAD_STATE["failed"]);
  });

  // S14: the whole point. No custody sentence may name a gateway, a replica,
  // a sweep or a tier — a member does not have those.
  it("SABOTAGE: no custody sentence uses engine vocabulary", () => {
    for (const line of Object.values(DOCS_CUSTODY))
      for (const engineWord of ["gateway", "replica", "tier", "sweep", "cloud"])
        expect({
          line,
          engineWord,
          used: line.toLowerCase().includes(engineWord),
        }).toStrictEqual({ line, engineWord, used: false });
  });
});
