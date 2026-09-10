// D2 (#1015): sentence case EVERYWHERE. Photos used to ship two casing systems
// — Title Case menus and a Title Case selection bar justified as "iOS Photos
// wording (#712)" — beside the sentence case the rest of the app keeps. This
// sweeps every Photos copy table a pure module owns, so a Title Case label
// cannot come back in unnoticed.

import { describe, expect, it, vi } from "vitest";

import { selectedSentence } from "../../kit/rooms/room-contracts";
import { PHOTOS_BAND_DESTINATIONS, PHOTOS_MORE_ROWS } from "./photos-band";
import { collectionsMenuGroups } from "./photos-collections-menu";
import { libraryMenuGroups } from "./photos-library-menu";
import { viewerOverflowMenuGroups } from "./viewer-menu";

/**
 * Words that are capitalised because of what they name, not because of a
 * casing system: proper nouns and the app's own place names. A label may open
 * with any of these; only a mid-label capital that is NOT one of them is Title
 * Case. Acronyms (`XS`, `S`, `M`, `L` — the rung labels) are all-caps and are
 * not sentence-case breaks either.
 */
const PROPER_NOUNS = new Set([
  "Photos",
  "Library",
  "Collections",
  "Search",
  "More",
  "Backup",
  "Trash",
  "Archive",
  "Favorites",
  "Memories",
  "Places",
  "People",
  "Duplicates",
  "Date",
  "Time",
  "Free",
]);

/** Title Case = a capitalised word after the first that names nothing. */
function titleCaseWords(label: string): string[] {
  // A refusal rides after an em dash; that clause is its own sentence.
  return label.split("—").flatMap((clause) =>
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

function menuLabels(groups: ReturnType<typeof libraryMenuGroups>): string[] {
  const out: string[] = [];
  const walk = (
    rows: readonly { label: string; rows?: readonly unknown[] }[]
  ): void => {
    for (const row of rows) {
      out.push(row.label);
      if (Array.isArray(row.rows)) walk(row.rows as never);
    }
  };
  for (const group of groups) walk(group.rows as never);
  return out;
}

const libraryLabels = menuLabels(
  libraryMenuGroups({
    filter: "all",
    onFilter: vi.fn<() => void>(),
    rung: 2,
    onRung: vi.fn<() => void>(),
    grain: "all",
    detectFaces: {
      availability: { available: true },
      onDetectFaces: vi.fn<() => void>(),
    },
  })
);

const viewerLabels = menuLabels(
  viewerOverflowMenuGroups({
    writable: true,
    hasVaultAsset: true,
    archived: false,
    albums: [{ id: "a1", label: "Trip" }],
    onSlideshow: vi.fn<() => void>(),
    onAddToAlbum: vi.fn<() => void>(),
    onMakeKeyPhoto: vi.fn<() => void>(),
    onAdjustLocation: vi.fn<() => void>(),
    onHide: vi.fn<() => void>(),
    onDownload: vi.fn<() => void>(),
    onSendCopy: vi.fn<() => void>(),
    onDelete: vi.fn<() => void>(),
  })
);

const collectionsLabels = menuLabels(
  collectionsMenuGroups({
    onShowAll: vi.fn<() => void>(),
    onCollapseAll: vi.fn<() => void>(),
  })
);

describe("every Photos copy table is sentence case (D2, #1015)", () => {
  it.each([
    ["library header menu", libraryLabels],
    ["viewer overflow menu", viewerLabels],
    ["collections header menu", collectionsLabels],
    ["band destinations", PHOTOS_BAND_DESTINATIONS.map((d) => d.label)],
    ["More sheet rows", PHOTOS_MORE_ROWS.map((row) => row.label)],
    [
      "selection header",
      [1, 4].map((count) =>
        selectedSentence({
          actions: [],
          count,
          noun: "photograph",
          onCancel: () => undefined,
        })
      ),
    ],
  ])("%s", (_where, labels) => {
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels)
      expect({ label, titleCase: titleCaseWords(label) }).toStrictEqual({
        label,
        titleCase: [],
      });
  });

  it("names the selection with its noun, and counts in sentence case", () => {
    // The room writes this sentence now (#1015 Wave 2): Photos' own
    // `selectionCountLabel` is gone, and the noun it passes is what is swept.
    const say = (count: number): string =>
      selectedSentence({
        actions: [],
        count,
        noun: "photograph",
        onCancel: () => undefined,
      });
    expect(say(1)).toBe("1 photograph selected");
    expect(say(4)).toBe("4 photographs selected");
  });

  it("ships one English: the faces ask is spelled the American way, like `favorite`", () => {
    expect(libraryLabels).toContain("Prioritize faces");
    expect(libraryLabels.join(" ")).not.toContain("Prioritise");
  });
});
