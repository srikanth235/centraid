import { describe, expect, it } from "vitest";

import {
  NO_LOCATION_KEY,
  placeSectionsWithNoLocation,
} from "./components/Places.tsx";
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
// The seeded roll's own geography (`seed.js`): a declared home in Palo Alto, an
// errand a few kilometres from it, and a Tahoe trip ~250 km away. Realistic
// coordinates matter here — the bands these tests assert are distances.
const HOME: PlaceSection = {
  key: "place-home",
  name: "Home",
  kind: "home",
  assets: [asset("h1"), asset("h2")],
  lat: 37.4419,
  lng: -122.143,
};
const AROUND_TOWN: PlaceSection = {
  key: "place-park",
  name: "The park by the school",
  assets: [asset("p1")],
  lat: 37.47,
  lng: -122.16,
};
/** The member named this one "the shore"; the gazetteer says which shore. */
const SHORE: PlaceSection = {
  key: "place-shore",
  name: "the shore",
  gazetteer: "South Lake Tahoe, CA",
  assets: [asset("s1"), asset("s2")],
  lat: 38.9542,
  lng: -120.1094,
};
/** Unnamed, and 250 km from home: the gazetteer is all it has. */
const RIVER_BEND: PlaceSection = {
  key: "place-river",
  name: "39.16820, -120.14290",
  gazetteer: "Truckee, CA",
  assets: [asset("r1")],
  lat: 39.1682,
  lng: -120.1429,
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

// THE NO-LOCATION BUCKET (#816): the one set Places could not show.
const NO_LOCATION_SECTION: PlaceSection = {
  key: NO_LOCATION_KEY,
  name: "No location yet",
  assets: [asset("n1"), asset("n2"), asset("n3")],
  lat: null,
  lng: null,
};

// A PLACE IS A SEARCH TERM (#816). A place that answered to exactly one
// string — the `name` column — left the Tahoe trip unfindable by the word
// "Tahoe" whenever the member had called the sections something else or the
// vault had called them a coordinate, and matched nothing at all for
// "near home".
describe("the vocabulary a place answers to", () => {
  function placesFor(query: string, sections: readonly PlaceSection[]) {
    return searchGroups({
      query,
      people: [],
      placeSections: sections,
      albums: [],
      ownAssets: [],
      hits: [],
    }).filter((group) => group.kind === "place");
  }

  const ROLL = [HOME, AROUND_TOWN, SHORE, RIVER_BEND];

  it("finds a place by the gazetteer's settlement name, and still titles it with the member's own name", () => {
    const [hit] = placesFor("tahoe", ROLL);
    // "the shore" is what the member called it; the gazetteer is how it was
    // FOUND. A name a person entered outranks a derived one in display, always.
    expect(hit?.title).toBe("the shore");
    expect(hit?.meta).toBe("place · 2 photographs");
    expect(hit?.targetShelf).toBe(PLACES);
  });

  it("does not pull in a section whose gazetteer says somewhere else", () => {
    // Truckee is thirty kilometres from the lake shore and is not called Tahoe.
    // A search that returned it for "tahoe" would be guessing at geography.
    expect(placesFor("tahoe", ROLL).map((hit) => hit.key)).toStrictEqual([
      "place-shore",
    ]);
    // …and Truckee IS findable, by its own name, titled through the ladder's
    // gazetteer rung because the place itself is unnamed.
    expect(placesFor("truckee", ROLL)[0]).toMatchObject({
      key: "place-river",
      title: "near Truckee, CA",
    });
  });

  it("answers 'near home' with home and everything around town, and nothing on the trip", () => {
    for (const query of ["home", "near home", "at home"]) {
      expect(placesFor(query, ROLL).map((hit) => hit.key)).toStrictEqual([
        "place-home",
        "place-park",
      ]);
    }
  });

  it("has no home vocabulary at all until a member declares which place is home", () => {
    // No `kind: 'home'` anywhere — search does NOT fall back to the busiest
    // place or the modal coordinate, because "near home" is a claim about a
    // place a person named.
    const unanchored = [{ ...HOME, kind: null }, AROUND_TOWN];
    expect(placesFor("near home", unanchored)).toStrictEqual([]);
  });

  it("titles a hit with a phrase, never a coordinate — whatever matched it", () => {
    const queries = [
      "home",
      "near home",
      "at home",
      "around town",
      "tahoe",
      "truckee",
      "shore",
      "no location",
      "37.4",
      "39.16",
    ];
    for (const query of queries) {
      for (const hit of placesFor(query, [...ROLL, NO_LOCATION_SECTION])) {
        expect(hit.title).not.toMatch(/^-?\d{1,3}\.\d+,\s*-?\d{1,3}\.\d+$/u);
      }
    }
    // And a coordinate is not a search term either: the digits stored on an
    // unnamed place are a placeholder, not a name a member would type.
    expect(placesFor("39.16", ROLL)).toStrictEqual([]);
  });
});

describe("the no-location bucket", () => {
  it("is the trailing section of the shelf, holding exactly the place-less rows", () => {
    const sections = placeSectionsWithNoLocation([
      { asset_id: "a", place: { place_id: "p1", name: "Lyme Regis" } },
      { asset_id: "b" },
      { asset_id: "c", place: null },
    ]);
    expect(sections.map((section) => section.key)).toStrictEqual([
      "p1",
      NO_LOCATION_KEY,
    ]);
    const bucket = sections.at(-1)!;
    expect(bucket.name).toBe("No location yet");
    expect(bucket.assets.map((a) => a.asset_id)).toStrictEqual(["b", "c"]);
    // No coordinates, so `PlaceMap.placePoints` draws no pin for it.
    expect(bucket.lat).toBeNull();
    expect(bucket.lng).toBeNull();
  });

  it("is absent when every photograph carries a place", () => {
    expect(
      placeSectionsWithNoLocation([
        { asset_id: "a", place: { place_id: "p1", name: "Lyme Regis" } },
      ]).map((section) => section.key)
    ).toStrictEqual(["p1"]);
  });

  it("is a hit a member can open, with the right count, for each of the words they would type", () => {
    for (const query of ["no location", "no place", "unlocated"]) {
      const hit = searchGroups({
        query,
        people: [],
        placeSections: [LYME, NO_LOCATION_SECTION],
        albums: [],
        ownAssets: [],
        hits: [],
      }).find((group) => group.kind === "place");
      expect(hit).toMatchObject({
        key: NO_LOCATION_KEY,
        title: "No location yet",
        meta: "place · 3 photographs",
        targetShelf: PLACES,
      });
    }
  });
});
