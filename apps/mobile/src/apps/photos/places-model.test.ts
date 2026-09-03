import { describe, expect, it } from "vitest";

import { PLACE_UNNAMED } from "@centraid/blueprints/apps/photos/shared-copy";

import { makePhotosFixture } from "./photos-fixtures";
import {
  assetsAtPlace,
  assetsWithNoPlace,
  NO_LOCATION_KEY,
  NO_LOCATION_NAME,
  noLocationCard,
  PIN_MIN,
  pinLabel,
  pinSize,
  placeCardKey,
  placeCards,
  placeCells,
  placeNameAt,
  placePoints,
  unnamedPlaceAt,
} from "./places-model";
import type { PlaceRow } from "./places-model";
import type { PhotoAsset } from "./timeline-model";

const [BASE] = makePhotosFixture("place-tagged").assets;

function photo(
  id: string,
  placeId: string | undefined,
  patch: Partial<PhotoAsset> = {}
): PhotoAsset {
  const asset: PhotoAsset = {
    ...BASE!,
    id,
    filename: `${id}.jpg`,
    previewUri: `https://fixture.invalid/thumb/${id}`,
    uri: `https://fixture.invalid/thumb/${id}`,
    ...patch,
  };
  if (placeId === undefined) delete asset.placeId;
  else asset.placeId = placeId;
  return asset;
}

const TAHOE: PlaceRow = {
  place_id: "place-tahoe",
  name: "Lake Tahoe",
  geo_lat: 39.096_8,
  geo_lng: -120.032_4,
};
const TAHOE_CABIN: PlaceRow = {
  place_id: "place-cabin",
  name: "The cabin",
  geo_lat: 39.14,
  geo_lng: -120.03,
};
const HOME: PlaceRow = {
  place_id: "place-home",
  name: "Home",
  geo_lat: 37.44,
  geo_lng: -122.14,
};

describe("the Places shelf's cards", () => {
  it("counts the photographs taken at each place, busiest place first", () => {
    const cards = placeCards(
      [
        photo("a", "place-home"),
        photo("b", "place-tahoe"),
        photo("c", "place-tahoe"),
      ],
      [TAHOE, HOME]
    );
    expect(cards.map((card) => [card.name, card.count])).toStrictEqual([
      ["Lake Tahoe", 2],
      ["Home", 1],
    ]);
  });

  it("merges two place rows inside one 0.1° cell into a single card", () => {
    const cards = placeCards(
      [photo("a", "place-tahoe"), photo("b", "place-cabin")],
      [TAHOE, TAHOE_CABIN]
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]!.count).toBe(2);
  });

  it("cards a place whose row has no name as the unnamed place, never drops it", () => {
    const cards = placeCards(
      [photo("a", "place-home")],
      [{ place_id: "place-home", geo_lat: 37.44, geo_lng: -122.14 }]
    );
    expect(cards.map((card) => card.name)).toStrictEqual([PLACE_UNNAMED]);
  });

  it("covers a card with the newest photograph taken there", () => {
    const cards = placeCards(
      [photo("newest", "place-tahoe"), photo("older", "place-tahoe")],
      [TAHOE]
    );
    expect(cards[0]!.coverUri).toBe("https://fixture.invalid/thumb/newest");
  });

  it("leaves a photograph that carries no place off the shelf entirely", () => {
    expect(
      placeCards([photo("nowhere", undefined)], [TAHOE, HOME])
    ).toStrictEqual([]);
  });

  it("draws no card for a place nothing was photographed at", () => {
    expect(placeCards([photo("a", "place-home")], [TAHOE, HOME])).toHaveLength(
      1
    );
  });

  it("draws no card for a place whose row records no coordinates", () => {
    const roomOnly: PlaceRow = { place_id: "place-room", name: "The kitchen" };
    expect(placeCardKey(roomOnly)).toBeNull();
    expect(placeCards([photo("a", "place-room")], [roomOnly])).toStrictEqual(
      []
    );
  });
});

describe("naming a place (issue #816)", () => {
  const COORD: PlaceRow = {
    place_id: "place-coord",
    name: "39.0968, -120.0324",
    geo_lat: 39.096_8,
    geo_lng: -120.032_4,
  };
  const COORD_KEY = "39.1:-120.0";

  it("cards a coordinate-labelled place as unnamed, never as its digits", () => {
    const cards = placeCards([photo("a", "place-coord")], [COORD]);
    expect(cards.map((card) => card.name)).toStrictEqual([PLACE_UNNAMED]);
  });

  it("offers the coordinate-labelled row as the one to name", () => {
    expect(
      unnamedPlaceAt([photo("a", "place-coord")], [COORD], COORD_KEY)
    ).toBe("place-coord");
  });

  it("offers a row with no name at all as the one to name", () => {
    const nameless: PlaceRow = {
      place_id: "place-bare",
      name: "",
      geo_lat: 39.096_8,
      geo_lng: -120.032_4,
    };
    expect(
      unnamedPlaceAt([photo("a", "place-bare")], [nameless], COORD_KEY)
    ).toBe("place-bare");
  });

  it("asks nothing of a place the member already named", () => {
    expect(
      unnamedPlaceAt([photo("a", "place-tahoe")], [TAHOE], COORD_KEY)
    ).toBeNull();
  });

  it("names the row the card took its title from, not a neighbour in the cell", () => {
    const assets = [
      photo("newest", "place-coord"),
      photo("older", "place-cabin"),
    ];
    const cards = placeCards(assets, [COORD, TAHOE_CABIN]);
    expect(cards[0]!.name).toBe(PLACE_UNNAMED);
    expect(unnamedPlaceAt(assets, [COORD, TAHOE_CABIN], cards[0]!.id)).toBe(
      "place-coord"
    );
  });

  it("ignores a trashed photograph when deciding what to ask about", () => {
    const assets = [
      photo("trashed", "place-coord", { deleted: true }),
      photo("kept", "place-tahoe"),
    ];
    expect(unnamedPlaceAt(assets, [COORD, TAHOE], COORD_KEY)).toBeNull();
  });

  it("prints no name for a coordinate-labelled row, so a caller falls back", () => {
    expect(
      placeNameAt([photo("a", "place-coord")], [COORD], COORD_KEY)
    ).toBeNull();
  });

  it("prints the member's own name once the row carries one", () => {
    const named: PlaceRow = { ...COORD, name: "Grandma's house" };
    expect(placeNameAt([photo("a", "place-coord")], [named], COORD_KEY)).toBe(
      "Grandma's house"
    );
  });

  it("asks nothing when no photograph at that key exists", () => {
    expect(
      unnamedPlaceAt([photo("a", "place-home")], [HOME], "0.0:0.0")
    ).toBeNull();
  });
});

describe("the place a card opens", () => {
  it("hands the detail screen exactly the photographs its card counted", () => {
    const assets = [
      photo("a", "place-tahoe"),
      photo("b", "place-cabin"),
      photo("c", "place-home"),
    ];
    const rows = [TAHOE, TAHOE_CABIN, HOME];
    for (const card of placeCards(assets, rows)) {
      expect(assetsAtPlace(assets, rows, card.id)).toHaveLength(card.count);
    }
  });

  it("keeps a trashed photograph out of the place it was taken at", () => {
    const assets = [
      photo("kept", "place-home"),
      photo("trashed", "place-home", { deleted: true }),
    ];
    expect(
      assetsAtPlace(assets, [HOME], placeCardKey(HOME)!).map(
        (asset) => asset.id
      )
    ).toStrictEqual(["kept"]);
  });

  it("shows nothing for a place key no row resolves to", () => {
    expect(
      assetsAtPlace([photo("a", "place-home")], [HOME], "0.0:0.0")
    ).toStrictEqual([]);
  });
});

describe("the points the map plots", () => {
  it("keeps two nearby places apart, leaving the merge to the drawing", () => {
    const points = placePoints(
      [photo("a", "place-tahoe"), photo("b", "place-cabin")],
      [TAHOE, TAHOE_CABIN]
    );
    expect(points.map((point) => point.key)).toStrictEqual([
      "place-tahoe",
      "place-cabin",
    ]);
  });

  it("plots a place row carrying the vault's own geo_lat/geo_lng columns", () => {
    const points = placePoints(
      [photo("a", "place-tahoe")],
      [
        {
          place_id: "place-tahoe",
          name: "Lake Tahoe",
          geo_lat: 39.1,
          geo_lng: -120,
        },
      ]
    );
    expect(points).toStrictEqual([
      {
        key: "place-tahoe",
        lat: 39.1,
        lng: -120,
        count: 1,
        name: "Lake Tahoe",
        thumb: "https://fixture.invalid/thumb/a",
      },
    ]);
  });

  it("counts every photograph taken at a place into its one point", () => {
    const points = placePoints(
      [photo("a", "place-tahoe"), photo("b", "place-tahoe")],
      [TAHOE]
    );
    expect(points.map((point) => point.count)).toStrictEqual([2]);
  });

  it("draws a pin as the most recent photograph taken there", () => {
    const points = placePoints(
      [photo("newest", "place-tahoe"), photo("older", "place-tahoe")],
      [TAHOE]
    );
    expect(points[0]!.thumb).toBe("https://fixture.invalid/thumb/newest");
  });

  it("gives an unnamed place a null name rather than inventing one", () => {
    const points = placePoints(
      [photo("a", "place-home")],
      [{ place_id: "place-home", geo_lat: 37.44, geo_lng: -122.14 }]
    );
    expect(points[0]!.name).toBeNull();
  });
});

describe("the columns a place's coordinates arrive in (#787)", () => {
  it("cards, opens, and plots one vault-shaped row through one key", () => {
    const assets = [photo("a", "place-tahoe"), photo("b", "place-tahoe")];
    const cards = placeCards(assets, [TAHOE]);
    expect(cards.map((card) => [card.id, card.count])).toStrictEqual([
      ["39.1:-120.0", 2],
    ]);
    expect(
      assetsAtPlace(assets, [TAHOE], cards[0]!.id).map((asset) => asset.id)
    ).toStrictEqual(["a", "b"]);
    expect(
      placePoints(assets, [TAHOE]).map((point) => [point.lat, point.lng])
    ).toStrictEqual([[39.096_8, -120.032_4]]);
  });

  it("gives a row whose geo columns are explicit NULLs neither card nor pin", () => {
    const noGeo: PlaceRow = {
      place_id: "place-room",
      name: "The kitchen",
      geo_lat: null,
      geo_lng: null,
    };
    expect(placeCardKey(noGeo)).toBeNull();
    expect(placeCards([photo("a", "place-room")], [noGeo])).toStrictEqual([]);
    expect(placePoints([photo("a", "place-room")], [noGeo])).toStrictEqual([]);
  });

  it("drops a coordinate that is not a number, even when it would coerce", () => {
    const stringy: PlaceRow = {
      place_id: "place-string",
      name: "Typed in",
      geo_lat: "39.1",
      geo_lng: "-120.0",
    };
    expect(placeCardKey(stringy)).toBeNull();
    expect(placePoints([photo("a", "place-string")], [stringy])).toStrictEqual(
      []
    );
  });

  it("still cards a legacy latitude/longitude row as a fallback", () => {
    const legacy: PlaceRow = {
      place_id: "place-legacy",
      name: "Legacy",
      latitude: 39.096_8,
      longitude: -120.032_4,
    };
    expect(placeCardKey(legacy)).toBe("39.1:-120.0");
    expect(
      placePoints([photo("a", "place-legacy")], [legacy]).map((point) => [
        point.lat,
        point.lng,
      ])
    ).toStrictEqual([[39.096_8, -120.032_4]]);
  });

  it("still cards a legacy lat/lng row as the last fallback", () => {
    const short: PlaceRow = {
      place_id: "place-short",
      name: "Short",
      lat: 39.096_8,
      lng: -120.032_4,
    };
    expect(placeCardKey(short)).toBe("39.1:-120.0");
    expect(
      placePoints([photo("a", "place-short")], [short]).map((point) => [
        point.lat,
        point.lng,
      ])
    ).toStrictEqual([[39.096_8, -120.032_4]]);
  });
});

describe("what a pin says and how big it is", () => {
  it("floors a lone pin at a fingertip", () => {
    expect(pinSize(1, 1)).toBe(PIN_MIN);
  });

  it("scales a pin by AREA, so four photographs read as twice one", () => {
    const busiest = pinSize(4, 4);
    const quiet = pinSize(1, 4);
    expect(quiet - PIN_MIN).toBe(Math.round((busiest - PIN_MIN) / 2));
  });

  it("names the place and counts its photographs in the singular", () => {
    expect(
      pinLabel({
        key: "k",
        x: 0,
        y: 0,
        count: 1,
        name: "Lake Tahoe",
        places: 1,
      })
    ).toBe("Lake Tahoe, 1 photograph");
  });

  it("says how many other places a merged pin stands for", () => {
    expect(
      pinLabel({
        key: "k",
        x: 0,
        y: 0,
        count: 9,
        name: "Lake Tahoe",
        places: 3,
      })
    ).toBe("Lake Tahoe and 2 more nearby, 9 photographs");
  });

  it("refuses to read a coordinate out as a place name", () => {
    expect(
      pinLabel({
        key: "k",
        x: 0,
        y: 0,
        count: 2,
        name: "39.0968, -120.0324",
        places: 1,
      })
    ).toBe("an unnamed place, 2 photographs");
  });
});

describe("the photographs that carry no place at all", () => {
  it("is exactly the rows with no place id, trash excluded", () => {
    const assets = [
      photo("scan", undefined),
      photo("screenshot", undefined),
      photo("binned", undefined, { deleted: true }),
      photo("placed", "place-home"),
    ];
    expect(assetsWithNoPlace(assets).map((asset) => asset.id)).toStrictEqual([
      "scan",
      "screenshot",
    ]);
  });

  it("keeps a photograph at a coordinate-less place OUT of the bucket — it has a place", () => {
    const roomOnly: PlaceRow = { place_id: "place-room", name: "The kitchen" };
    expect(placeCardKey(roomOnly)).toBeNull();
    expect(assetsWithNoPlace([photo("a", "place-room")])).toStrictEqual([]);
  });

  it("cards the bucket with its own honest name, its count and a cover", () => {
    const card = noLocationCard([
      photo("scan", undefined),
      photo("placed", "place-home"),
      photo("screenshot", undefined),
    ]);
    expect(card).toStrictEqual({
      id: NO_LOCATION_KEY,
      name: NO_LOCATION_NAME,
      count: 2,
      coverUri: "https://fixture.invalid/thumb/scan",
    });
    expect(card?.name).toBe("No location yet");
  });

  it("draws no card when every photograph carries a place", () => {
    expect(noLocationCard([photo("a", "place-home")])).toBeNull();
  });

  it("opens the same set the card counted, through the reserved key", () => {
    const assets = [
      photo("scan", undefined),
      photo("screenshot", undefined),
      photo("placed", "place-home"),
    ];
    const card = noLocationCard(assets)!;
    expect(assetsAtPlace(assets, [HOME], card.id)).toHaveLength(card.count);
    expect(
      assetsAtPlace(assets, [HOME], NO_LOCATION_KEY).map((asset) => asset.id)
    ).toStrictEqual(["scan", "screenshot"]);
  });

  it("does not answer for the bucket's key with a real place's photographs", () => {
    expect(
      assetsAtPlace([photo("a", "place-home")], [HOME], NO_LOCATION_KEY)
    ).toStrictEqual([]);
  });
});

describe("collapsing place rows onto the shelf's own cells", () => {
  it("returns one cell for rows that round together, keeping both ids", () => {
    const cells = placeCells([TAHOE, TAHOE_CABIN, HOME]);
    expect(cells.map((cell) => cell.key)).toStrictEqual([
      "39.1:-120.0",
      "37.4:-122.1",
    ]);
    expect(cells[0]!.placeIds).toStrictEqual(["place-tahoe", "place-cabin"]);
  });

  it("names a cell from the first row carrying a real name", () => {
    const unnamed: PlaceRow = {
      place_id: "place-raw",
      name: "39.1400, -120.0300",
      geo_lat: 39.14,
      geo_lng: -120.03,
    };
    expect(placeCells([unnamed, TAHOE])[0]).toMatchObject({
      name: "Lake Tahoe",
      placeIds: ["place-raw", "place-tahoe"],
    });
    expect(placeCells([unnamed])[0]!.name).toBe(PLACE_UNNAMED);
  });

  it("drops a row with no usable coordinates rather than inventing a cell", () => {
    expect(
      placeCells([{ place_id: "place-nowhere", name: "Nowhere" }])
    ).toStrictEqual([]);
  });
});
