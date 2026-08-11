import { describe, expect, it } from "vitest";

import type { PlaceSection } from "./components/Places.tsx";
import type { Person } from "./people.ts";
import { searchGroupOpenLabel, searchGroups } from "./search-groups.ts";
import { PLACES } from "./shelves.ts";
import type { Album, Asset } from "./types.ts";

function asset(id: string, extra: Partial<Asset> = {}): Asset {
  return { asset_id: id, ...extra };
}

const ANA: Person = {
  party_id: "party-ana",
  name: "Ana",
  count: 412,
  asset_ids: ["a1", "a2", "a3"],
};
const LYME: PlaceSection = {
  key: "place-lyme",
  name: "Lyme Regis",
  assets: [asset("a4"), asset("a5")],
  lat: 50.7256,
  lng: -2.9366,
};
const COAST_ALBUM: Album = {
  album_id: "album-coast",
  title: "The coast road",
  count: 7,
};

describe(searchGroups, () => {
  it("is empty for an empty query — resting has no hits to group", () => {
    expect(
      searchGroups({
        query: "",
        people: [ANA],
        placeSections: [LYME],
        albums: [COAST_ALBUM],
        ownAssets: [],
        hits: [],
      })
    ).toStrictEqual([]);
  });

  it("matches a person by name, case-insensitively, with an exact library count and an honest 'here' count", () => {
    const hits = [asset("a1"), asset("a9")]; // only a1 of Ana's photos is among the loaded hits
    const groups = searchGroups({
      query: "an",
      people: [ANA],
      placeSections: [],
      albums: [],
      ownAssets: [],
      hits,
    });
    const person = groups.find((g) => g.kind === "person");
    expect(person).toBeDefined();
    expect(person?.title).toBe("Ana");
    expect(person?.meta).toBe("person · 412 photographs");
    expect(person?.here).toBe("1 here");
    expect(person?.targetShelf).toBe("person:party-ana");
  });

  it("matches a place by name and counts the photographs in its own section, opening to Places", () => {
    const groups = searchGroups({
      query: "lyme",
      people: [],
      placeSections: [LYME],
      albums: [],
      ownAssets: [],
      hits: [],
    });
    const place = groups.find((g) => g.kind === "place");
    expect(place?.title).toBe("Lyme Regis");
    expect(place?.meta).toBe("place · 2 photographs");
    expect(place?.targetShelf).toBe(PLACES);
  });

  it("matches an album by title and opens straight to the album id", () => {
    const groups = searchGroups({
      query: "coast",
      people: [],
      placeSections: [],
      albums: [COAST_ALBUM],
      ownAssets: [],
      hits: [],
    });
    const album = groups.find((g) => g.kind === "album");
    expect(album?.title).toBe("The coast road");
    expect(album?.meta).toBe("album · 7 photographs");
    expect(album?.targetShelf).toBe("album-coast");
  });

  it("aggregates a matching tag across every asset that carries it, and opens the tag shelf", () => {
    const ownAssets = [
      asset("t1", { tags: [{ tag_id: "1", label: "beach" }] }),
      asset("t2", {
        tags: [
          { tag_id: "1", label: "beach" },
          { tag_id: "2", label: "sea" },
        ],
      }),
      asset("t3", { tags: [{ tag_id: "3", label: "mountains" }] }),
    ];
    const groups = searchGroups({
      query: "bea",
      people: [],
      placeSections: [],
      albums: [],
      ownAssets,
      hits: [],
    });
    const things = groups.find((g) => g.kind === "things");
    expect(things?.title).toBe("beach");
    expect(things?.meta).toBe("things · found in 2 photographs");
    expect(things?.targetShelf).toBe("tag:beach");
  });

  it("never fabricates a hit for a group with no match", () => {
    const groups = searchGroups({
      query: "nobody-matches-this-query",
      people: [ANA],
      placeSections: [LYME],
      albums: [COAST_ALBUM],
      ownAssets: [],
      hits: [],
    });
    expect(groups).toStrictEqual([]);
  });

  it("names the shelf a group's Open control announces", () => {
    const [person] = searchGroups({
      query: "an",
      people: [ANA],
      placeSections: [],
      albums: [],
      ownAssets: [],
      hits: [],
    });
    expect(searchGroupOpenLabel(person!)).toBe("Open Ana");
  });
});
