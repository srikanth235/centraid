// The arithmetic the phone's three Places surfaces share (issue #781).
//
// Places shipped with a tested projection (`place-map.test.ts` owns the
// pixels, the graticule and the scale bar) and an untested seat: nothing
// checked which rows become a card, which become a pin, or that the count on
// a card matches the screen that card opens. Those are this file's claims —
// the projection's own arithmetic is deliberately NOT restated here.
//
// The law worth naming is the third one: `placeCards` and `assetsAtPlace` are
// two readers of one key, and a card whose detail opens empty is the exact
// "labelled destination opens something else" defect the Photos seat has hit
// before. It is provable in milliseconds without a renderer, which is why it
// lives here rather than in a component test.
import { describe, expect, it } from "vitest";

import { PLACE_UNNAMED } from "@centraid/blueprints/apps/photos/shared-copy";

import { makePhotosFixture } from "./photos-fixtures";
import {
  assetsAtPlace,
  PIN_MIN,
  pinLabel,
  pinSize,
  placeCardKey,
  placeCards,
  placeNameAt,
  placePoints,
  unnamedPlaceAt,
} from "./places-model";
import type { PlaceRow } from "./places-model";
import type { PhotoAsset } from "./timeline-model";

// One deterministic corpus row, re-keyed per case — every field a Places
// surface reads (id, placeId, previewUri, uri, deleted) is set explicitly.
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

/** Lake Tahoe and a house on the same lake, ~1.5km apart: two ledger rows,
 *  one 0.1° cell. The columns are `geo_lat`/`geo_lng` because that is what
 *  `core_place` ships and the mobile timeline hands rows raw (#787). */
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
    // Two rows in the ledger, ~1.5km apart. A shelf that listed both would
    // ask a member to choose between "Lake Tahoe" and "The cabin" for one
    // weekend; the card is the cell, and its name is the first row read.
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
    // The timeline hands assets over newest first, so the first one seen for
    // a cell is the most recent — not an arbitrary member of the group.
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
    // A room, or a venue someone typed: the record knows the name and no
    // geography, and a card for it would stand somewhere nobody measured.
    const roomOnly: PlaceRow = { place_id: "place-room", name: "The kitchen" };
    expect(placeCardKey(roomOnly)).toBeNull();
    expect(placeCards([photo("a", "place-room")], [roomOnly])).toStrictEqual(
      []
    );
  });
});

// A place minted from GPS is labelled with its own coordinate until a member
// names it. Both halves of that fact are this block's subject: the label is
// never printed as a name, and it is exactly the case the ask exists for.
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
    // Two rows in one 0.1° cell: the card is titled from the NEWEST
    // photograph's row, so the ask must be about that same row — otherwise a
    // member answers a question about a name they were never shown.
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
    // THE LAW: card and detail are two readers of one key. A card reading "2"
    // that opens an empty screen is this seat's worst defect class, and it is
    // the only thing here neither the projection nor a renderer can falsify.
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
    // The shelf folds these two rows into one card; the map does NOT fold
    // them here, because whether two pins collide depends on the box being
    // drawn and `projectPlaces` answers that in pixels.
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
  // `core_place` ships `geo_lat`/`geo_lng` and the mobile timeline hands rows
  // raw; the shelf shipped reading `latitude ?? lat` while the map read
  // `geo_lat` first — pins without cards. These cases pin the shared chain.
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
    // The vault stores "no geography" as NULL columns; the web handler drops
    // them by type (`typeof === "number"` in readPlaces), and the phone must
    // agree — not coerce NULL and hope the NaN falls out.
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
    // Number("39.1") is finite, so a coercing read would card this row; the
    // type guard the web applies refuses it instead.
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
    // sqrt(1)/sqrt(4) = 0.5 of the ramp — the smaller pin sits halfway
    // between the floor and the busiest pin, not a quarter of the way.
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
    // A place named "39.0968, -120.0324" has a name in the database and none
    // a person would recognise; printing it looks like an answer.
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
