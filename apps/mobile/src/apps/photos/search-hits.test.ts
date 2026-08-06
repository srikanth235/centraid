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
    // no scene/label table in the vault (media.media_asset, media.face_region,
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
