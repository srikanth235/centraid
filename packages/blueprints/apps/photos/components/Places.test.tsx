// @vitest-environment jsdom
// THE PLACES SHELF'S TRAILING "NO LOCATION" SECTION (#816).
//
// The photographs nobody told where they were taken were in the library and on
// no shelf: every section on Places stands for a place, so the set was reachable
// only by scrolling the whole timeline. It is a section now — and the three
// things worth pinning are that it renders with a name of its OWN (not the
// located-but-unnamed fallback, which is a different fact), that it carries the
// dom id a search hit scrolls to, and that the map above the sections draws no
// pin for it, because it has no coordinate to draw one at.
//
// A pure-view test in the technique `People.test.tsx` uses: the shelf holds no
// state this exercises, so `renderToStaticMarkup` over its props is enough.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Asset } from "../types.ts";
import { PLACE_UNNAMED } from "../view-copy.ts";
import { placePoints } from "./PlaceMap.tsx";
import {
  NO_LOCATION_KEY,
  placeSectionsWithNoLocation,
  PlacesShelf,
} from "./Places.tsx";

const ROLL: Asset[] = [
  {
    asset_id: "a",
    place: { place_id: "p1", name: "the shore", lat: 38.9542, lng: -120.1094 },
  },
  { asset_id: "b" },
  { asset_id: "c", place: null },
];

function markup(assets: readonly Asset[]): string {
  return renderToStaticMarkup(
    createElement(PlacesShelf, {
      sections: placeSectionsWithNoLocation(assets),
      containerWidth: 800,
      targetHeight: 160,
      rung: 2,
      selectMode: false,
      selectedIds: new Set<string>(),
      vaultOf: () => undefined,
      refresh: async () => {},
      onOpen: () => {},
      onToggleSelect: () => {},
      onEnterSelectMode: () => {},
    })
  );
}

describe("the no-location section", () => {
  it("renders with its own honest name, not the located-but-unnamed fallback", () => {
    const html = markup(ROLL);
    expect(html).toContain("No location yet");
    expect(html).not.toContain(PLACE_UNNAMED);
  });

  it("carries the dom id a search hit scrolls to", () => {
    // `search-groups.ts` hands back `key: "no-location"` with `targetShelf`
    // PLACES; `sectionDomId` is the other half of that handshake.
    expect(markup(ROLL)).toContain(`id="place-${NO_LOCATION_KEY}"`);
  });

  it("gets no pin on the map, because it has no coordinate", () => {
    const sections = placeSectionsWithNoLocation(ROLL);
    expect(placePoints(sections).map((point) => point.key)).toStrictEqual([
      "p1",
    ]);
  });

  it("is absent from a shelf where every photograph carries a place", () => {
    expect(markup([ROLL[0]!])).not.toContain("No location yet");
  });
});
