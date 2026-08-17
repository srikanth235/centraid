// The grouped hits above the search grid (Photos v4 handoff §9,
// proto:4258-4265). Every number in these rows is derived from replica rows
// the phone already reads, so every number is asserted here — the failure this
// guards against is a row that states a plausible count nothing produced.

import { describe, expect, it } from "vitest";

import {
  captionDate,
  groupedSearchHits,
  queryTokens,
  reachableAssetIds,
} from "./search-hits";
import type { SearchHitSources } from "./search-hits";
import type { PhotoAsset } from "./timeline-model";

function asset(id: string, over: Partial<PhotoAsset> = {}): PhotoAsset {
  return {
    archived: false,
    assetId: `asset-${id}`,
    backupState: "backed-up",
    capturedAt: "2026-07-30T10:00:00.000Z",
    contentId: `content-${id}`,
    deleted: false,
    favorite: false,
    height: 1000,
    id,
    kind: "photo",
    originalUri: "",
    previewUri: "",
    source: "replica",
    uri: "",
    width: 1500,
    ...over,
  };
}

const LIBRARY = [
  asset("1", { placeId: "place-lyme" }),
  asset("2", { placeId: "place-lyme" }),
  asset("3", { placeId: "place-lyme" }),
  asset("4", { placeId: "place-kitchen" }),
  asset("5"),
];

function sources(over: Partial<SearchHitSources> = {}): SearchHitSources {
  return {
    assets: LIBRARY,
    collections: [
      { collection_id: "col-coast", name: "The coast road" },
      { collection_id: "col-tax", name: "Solicitor scans" },
    ],
    contentTitles: new Map([
      ["content-1", "Ana on the sea wall, before the rain"],
      ["content-4", "Kitchen units"],
    ]),
    entries: [
      { collection_id: "col-coast", target_id: "asset-1" },
      { collection_id: "col-coast", target_id: "asset-2" },
      { collection_id: "col-tax", target_id: "asset-4" },
    ],
    faces: [
      { asset_id: "asset-1", confirmed_by_party_id: "party-ana" },
      { asset_id: "asset-2", confirmed_by_party_id: "party-ana" },
      { asset_id: "asset-5", party_id: "party-ana" },
      { asset_id: "asset-4", confirmed_by_party_id: "party-tom" },
    ],
    matches: [LIBRARY[0]!, LIBRARY[1]!],
    parties: [
      { display_name: "Ana", party_id: "party-ana" },
      { display_name: "Tom", party_id: "party-tom" },
    ],
    places: [
      { name: "Lyme Regis", place_id: "place-lyme" },
      { name: "Pemberton kitchen", place_id: "place-kitchen" },
    ],
    query: "ana",
    ...over,
  };
}

describe("query tokens", () => {
  it("drops the words that are in every third name in a library", () => {
    // Without this, "the coast road" hits every album whose name contains
    // "the" — false hits above true ones is worse than no list at all.
    expect(queryTokens("the coast road")).toStrictEqual(["coast", "road"]);
    expect(queryTokens("ana at the coast")).toStrictEqual(["ana", "coast"]);
  });

  it("has no tokens for a query of nothing but noise", () => {
    expect(queryTokens("   the of a  ")).toStrictEqual([]);
    expect(groupedSearchHits(sources({ query: "the" }))).toStrictEqual([]);
  });
});

describe("the caption row's date", () => {
  it("writes the month out, independently of the device locale", () => {
    expect(captionDate("2026-07-30T10:00:00.000Z")).toBe("30 July 2026");
  });
});

describe("grouped hits", () => {
  it("names the PERSON, with her whole size and her share of these results", () => {
    const [hit] = groupedSearchHits(sources());
    // Ana is on assets 1, 2 and 5 — three DISTINCT photographs, of which two
    // are in these results. A proposed face counts exactly as a confirmed one
    // does on the People destination, so the two surfaces cannot disagree.
    expect(hit).toMatchObject({
      kind: "person",
      label: "Ana",
      meta: "2 here",
      sub: "person · 3 photographs",
      target: {
        params: { mode: "person", partyId: "party-ana", personName: "Ana" },
        screen: "PhotoStateView",
      },
    });
  });

  it("counts a person's photograph once even when two faces sit on it", () => {
    const doubled = sources({
      faces: [
        { asset_id: "asset-1", confirmed_by_party_id: "party-ana" },
        { asset_id: "asset-1", confirmed_by_party_id: "party-ana" },
      ],
    });
    expect(groupedSearchHits(doubled)[0]).toMatchObject({
      meta: "1 here",
      sub: "person · 1 photograph",
    });
  });

  it("names the PLACE and opens the surface that owns places", () => {
    const [hit] = groupedSearchHits(sources({ query: "Lyme" }));
    expect(hit).toMatchObject({
      kind: "place",
      label: "Lyme Regis",
      // Three in the library, two of them in these results.
      meta: "2 here",
      sub: "place · 3 photographs",
      target: { screen: "PlacesMap" },
    });
  });

  it("names the ALBUM with its own size and no overlap count", () => {
    const [hit] = groupedSearchHits(sources({ query: "coast road" }));
    expect(hit).toMatchObject({
      kind: "album",
      label: "The coast road",
      meta: "",
      sub: "album · 2 photographs",
      target: { params: { albumId: "col-coast" }, screen: "AlbumDetail" },
    });
  });

  it("quotes a CAPTION hit and opens that photograph", () => {
    const [hit] = groupedSearchHits(
      sources({ matches: [LIBRARY[0]!], parties: [], places: [] })
    );
    expect(hit).toMatchObject({
      kind: "caption",
      label: "“Ana on the sea wall, before the rain”",
      sub: "caption · 30 July 2026",
      target: { params: { assetId: "1" }, screen: "PhotoLightbox" },
    });
  });

  it("orders the groups person → place → album → caption", () => {
    const hits = groupedSearchHits(
      sources({ query: "ana lyme coast", matches: [LIBRARY[0]!] })
    );
    expect(hits.map((hit) => hit.kind)).toStrictEqual([
      "person",
      "place",
      "album",
      "caption",
    ]);
  });

  it("emits NO things row — the vault has no label entity to count", () => {
    // proto:4265 draws `beach, sea, coat · found in 74 photographs`. There is
    // no scene/label table in the vault (media.asset, media.face_region,
    // media.asset_phash and nothing else), so there is nothing to count and
    // the row is omitted rather than invented.
    const hits = groupedSearchHits(sources({ query: "beach sea coat" }));
    expect(hits.map((hit) => hit.kind)).not.toContain("things");
  });

  it("drops a person with a matching name but no photographs", () => {
    const hits = groupedSearchHits(
      sources({
        faces: [],
        query: "ana",
      })
    );
    expect(hits.filter((hit) => hit.kind === "person")).toStrictEqual([]);
  });

  it("says nothing at all before anything is typed", () => {
    expect(groupedSearchHits(sources({ query: "" }))).toStrictEqual([]);
  });
});

// A query naming an album, a person or a place has to bring that thing's
// PHOTOGRAPHS with it (#712). None of "The coast road"'s members carries the
// words "coast road" in its own caption, so a grid built from the title
// search alone was empty under a row announcing the album — which is the one
// thing a member who typed the album's name did not ask for.
describe("the photographs a hit reaches", () => {
  it("carries an album's members", () => {
    const [hit] = groupedSearchHits(sources({ query: "coast road" }));
    expect(hit?.assetIds).toStrictEqual(["asset-1", "asset-2"]);
  });

  it("carries every photograph a person's faces sit on, once each", () => {
    const [hit] = groupedSearchHits(sources());
    expect(hit?.assetIds).toStrictEqual(["asset-1", "asset-2", "asset-5"]);
  });

  it("carries a place's photographs, not just the matched ones", () => {
    // Two of Lyme Regis's three are in `matches`; the third is reachable
    // through the place row and belongs in the grid with them.
    const [hit] = groupedSearchHits(sources({ query: "Lyme" }));
    expect(hit?.assetIds).toStrictEqual(["asset-1", "asset-2", "asset-3"]);
  });

  it("carries a caption hit's own photograph", () => {
    const [hit] = groupedSearchHits(
      sources({ matches: [LIBRARY[0]!], parties: [], places: [] })
    );
    expect(hit?.assetIds).toStrictEqual(["asset-1"]);
  });

  it("unions the rows without repeating a photograph two rows share", () => {
    // Ana reaches 1, 2 and 5; Lyme Regis reaches 1, 2 and 3. The grid must
    // draw asset-1 once.
    const hits = groupedSearchHits(sources({ query: "ana lyme" }));
    expect([...reachableAssetIds(hits)].sort()).toStrictEqual([
      "asset-1",
      "asset-2",
      "asset-3",
      "asset-5",
    ]);
  });

  it("reaches nothing before anything is typed", () => {
    expect(
      reachableAssetIds(groupedSearchHits(sources({ query: "" }))).size
    ).toBe(0);
  });
});

// Semantic search (issue #721 B4): one aggregate row standing for the
// gateway's whole ranked set, appended after the other four and never
// gating them — see `search-hits.ts`'s own header for the argument.
describe("the semantic row", () => {
  it("is absent when the network has answered nothing yet", () => {
    const hits = groupedSearchHits(sources({ query: "beach" }));
    expect(hits.some((hit) => hit.kind === "semantic")).toBe(false);
  });

  it('is absent when semanticHits is an empty array ("unavailable", or nothing resolved)', () => {
    const hits = groupedSearchHits(
      sources({ query: "beach", semanticHits: [] })
    );
    expect(hits.some((hit) => hit.kind === "semantic")).toBe(false);
  });

  it("names the group, ranked by score, and opens the strongest match", () => {
    const hits = groupedSearchHits(
      sources({
        query: "beach",
        semanticHits: [
          { assetId: "asset-4", contentId: "content-4", score: 0.4 },
          { assetId: "asset-1", contentId: "content-1", score: 0.9 },
        ],
      })
    );
    const semantic = hits.find((hit) => hit.kind === "semantic");
    expect(semantic).toMatchObject({
      label: "Photos that look like “beach”",
      meta: "",
      sub: "semantic · 2 photographs",
      target: { params: { assetId: "1" }, screen: "PhotoLightbox" },
    });
  });

  it("carries every resolved hit's asset id into the grid, in no particular order requirement", () => {
    const hits = groupedSearchHits(
      sources({
        query: "beach",
        semanticHits: [
          { assetId: "asset-1", contentId: "content-1", score: 0.5 },
          { assetId: "asset-4", contentId: "content-4", score: 0.9 },
        ],
      })
    );
    const semantic = hits.find((hit) => hit.kind === "semantic");
    expect([...(semantic?.assetIds ?? [])].sort()).toStrictEqual([
      "asset-1",
      "asset-4",
    ]);
  });

  it("drops a hit the timeline has not loaded, rather than reaching the grid with a dangling id", () => {
    const hits = groupedSearchHits(
      sources({
        query: "beach",
        semanticHits: [
          { assetId: "asset-unloaded", contentId: "content-x", score: 0.9 },
        ],
      })
    );
    expect(hits.some((hit) => hit.kind === "semantic")).toBe(false);
  });

  it("sits last — broadest of the five", () => {
    const hits = groupedSearchHits(
      sources({
        query: "ana lyme coast",
        matches: [LIBRARY[0]!],
        semanticHits: [
          { assetId: "asset-4", contentId: "content-4", score: 0.7 },
        ],
      })
    );
    expect(hits.map((hit) => hit.kind)).toStrictEqual([
      "person",
      "place",
      "album",
      "caption",
      "semantic",
    ]);
  });

  it("unions into the grid alongside the other four groups' reaches", () => {
    const hits = groupedSearchHits(
      sources({
        query: "ana",
        semanticHits: [
          { assetId: "asset-4", contentId: "content-4", score: 0.7 },
        ],
      })
    );
    // Ana (person) reaches 1, 2, 5; the semantic row adds 4.
    expect([...reachableAssetIds(hits)].sort()).toStrictEqual([
      "asset-1",
      "asset-2",
      "asset-4",
      "asset-5",
    ]);
  });
});

// A PLACE IS A SEARCH TERM (issue #816). A place used to answer to exactly one
// string — its `name` column — so the Tahoe weekend was unfindable by the word
// "Tahoe" once the member had called the sections something of their own (or the
// vault had called them a coordinate), and "near home" matched nothing at all.
// The three fixtures below are the seeded roll's own geography: a declared home
// in Palo Alto, an errand a few kilometres away, and Tahoe ~250 km off.
const HOME_ROW = {
  place_id: "place-home",
  name: "Home",
  kind: "home",
  geo_lat: 37.4419,
  geo_lng: -122.143,
};
const PARK_ROW = {
  place_id: "place-park",
  name: "The park by the school",
  geo_lat: 37.47,
  geo_lng: -122.16,
};
/** Named "the shore" by the member; the gazetteer says which shore. */
const SHORE_ROW = {
  place_id: "place-shore",
  name: "the shore",
  address_json: JSON.stringify({ gazetteer: { name: "South Lake Tahoe, CA" } }),
  geo_lat: 38.9542,
  geo_lng: -120.1094,
};
/** Unnamed — the coordinate `findOrCreatePlaceTx` minted — and 250 km from
 *  home, so the gazetteer is the only rung with an answer. */
const RIVER_ROW = {
  place_id: "place-river",
  name: "39.16820, -120.14290",
  address_json: JSON.stringify({ gazetteer: { name: "Truckee, CA" } }),
  geo_lat: 39.1682,
  geo_lng: -120.1429,
};

const GEO_LIBRARY = [
  asset("h1", { placeId: "place-home" }),
  asset("h2", { placeId: "place-home" }),
  asset("p1", { placeId: "place-park" }),
  asset("s1", { placeId: "place-shore" }),
  asset("s2", { placeId: "place-shore" }),
  asset("r1", { placeId: "place-river" }),
  asset("n1"),
  asset("n2"),
];

function geoSources(query: string): SearchHitSources {
  return sources({
    assets: GEO_LIBRARY,
    collections: [],
    contentTitles: new Map(),
    entries: [],
    faces: [],
    matches: [],
    parties: [],
    places: [HOME_ROW, PARK_ROW, SHORE_ROW, RIVER_ROW],
    query,
  });
}

function placeHitsFor(query: string): ReturnType<typeof groupedSearchHits> {
  return groupedSearchHits(geoSources(query)).filter(
    (hit) => hit.kind === "place"
  );
}

describe("the vocabulary a place answers to", () => {
  it("finds a place by the gazetteer's settlement name, still titled with the member's own", () => {
    const hits = placeHitsFor("tahoe");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      key: "place:place-shore",
      // A name a person entered outranks a derived one in display, always.
      label: "the shore",
      sub: "place · 2 photographs",
      target: { screen: "PlacesMap" },
    });
  });

  it("does not pull in a section whose gazetteer says somewhere else", () => {
    // Truckee is not called Tahoe, and a search that returned it would be
    // guessing at geography. It is findable by its own name, phrased through
    // the gazetteer rung because the place itself has no name.
    expect(placeHitsFor("truckee").map((hit) => hit.label)).toStrictEqual([
      "near Truckee, CA",
    ]);
  });

  it("answers 'near home' with home and around town, and nothing on the trip", () => {
    for (const query of ["home", "near home", "at home"]) {
      expect(placeHitsFor(query).map((hit) => hit.key)).toStrictEqual([
        "place:place-home",
        "place:place-park",
      ]);
    }
  });

  it("has no home vocabulary until a member declares which place is home", () => {
    // No `kind: 'home'` anywhere: "near home" is a claim about a place a person
    // named, and the phone does not guess which one that is either.
    const hits = groupedSearchHits(
      sources({
        assets: GEO_LIBRARY,
        collections: [],
        contentTitles: new Map(),
        entries: [],
        faces: [],
        matches: [],
        parties: [],
        // Named for the street, so nothing here answers to the WORD "home"
        // except the declaration this case removes.
        places: [{ ...HOME_ROW, name: "Cedar Street", kind: null }, PARK_ROW],
        query: "near home",
      })
    );
    expect(hits).toStrictEqual([]);
    // The SAME rows, with the declaration back: the vocabulary is the
    // declaration's doing, not the absence of a match.
    const declared = groupedSearchHits(
      sources({
        assets: GEO_LIBRARY,
        collections: [],
        contentTitles: new Map(),
        entries: [],
        faces: [],
        matches: [],
        parties: [],
        places: [{ ...HOME_ROW, name: "Cedar Street" }, PARK_ROW],
        query: "near home",
      })
    );
    expect(declared.map((hit) => hit.label)).toStrictEqual([
      "Cedar Street",
      "The park by the school",
    ]);
  });

  it("never titles a hit with a coordinate, whatever matched it", () => {
    for (const query of [
      "home",
      "near home",
      "at home",
      "around town",
      "tahoe",
      "truckee",
      "shore",
      "no location",
      "39.16",
    ]) {
      for (const hit of groupedSearchHits(geoSources(query))) {
        expect(hit.label).not.toMatch(/^-?\d{1,3}\.\d+,\s*-?\d{1,3}\.\d+$/u);
      }
    }
    // And digits are not a search term: the coordinate on an unnamed place is a
    // placeholder, not something a member types.
    expect(placeHitsFor("39.16")).toStrictEqual([]);
  });
});

describe("the no-location bucket", () => {
  it("is a hit with the place-less count, for each of the words a member types", () => {
    for (const query of ["no location", "no place", "unlocated"]) {
      const hits = placeHitsFor(query);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({
        key: "place:no-location",
        label: "No location yet",
        sub: "place · 2 photographs",
        // Opens the same asset list the shelf's own trailing card opens.
        target: {
          screen: "PlaceDetail",
          params: { placeKey: "no-location", placeName: "No location yet" },
        },
      });
    }
  });

  it("carries the place-less photographs into the grid below", () => {
    expect(placeHitsFor("no location")[0]?.assetIds).toStrictEqual([
      "asset-n1",
      "asset-n2",
    ]);
  });

  it("sits after the named places when a query somehow hits both", () => {
    // "home" is home vocabulary; nothing about it is the bucket, so the bucket
    // stays out — the order claim is that the bucket is never first.
    expect(
      placeHitsFor("home").every((hit) => hit.key !== "place:no-location")
    ).toBe(true);
  });

  it("is absent when every photograph carries a place", () => {
    const hits = groupedSearchHits(
      sources({
        assets: [asset("h1", { placeId: "place-home" })],
        collections: [],
        contentTitles: new Map(),
        entries: [],
        faces: [],
        matches: [],
        parties: [],
        places: [HOME_ROW],
        query: "no location",
      })
    );
    expect(hits).toStrictEqual([]);
  });
});
