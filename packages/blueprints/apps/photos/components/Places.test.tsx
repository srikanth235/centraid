// @vitest-environment jsdom
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
