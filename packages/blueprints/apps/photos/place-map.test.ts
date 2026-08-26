import { describe, expect, it } from "vitest";

import type { MapCamera, PlacePoint } from "./place-map.ts";
import {
  coordAt,
  fitCamera,
  graticuleStep,
  kmPerPxForSpan,
  mapTier,
  pinAtPoint,
  projectAt,
  projectPlaces,
  readableName,
  tierMergeDistance,
  tierNoun,
  tileZoomFor,
} from "./place-map.ts";

const BOX = { width: 600, height: 360 };

/** The Tahoe roll the shelf renders. */
const TAHOE: PlacePoint[] = [
  { key: "home", lat: 37.4419, lng: -122.143, count: 4, name: "37.4419" },
  { key: "city", lat: 37.7955, lng: -122.3937, count: 3, name: "37.7955" },
  { key: "ridge", lat: 39.0021, lng: -120.1131, count: 2, name: "39.0021" },
  { key: "trail", lat: 38.9186, lng: -120.0836, count: 2, name: "38.9186" },
  { key: "bay", lat: 38.9542, lng: -120.1094, count: 1, name: "38.9542" },
];

describe("projecting places into a drawing box", () => {
  it("puts every pin inside the drawing box and loses no photographs", () => {
    const { pins } = projectPlaces(TAHOE, BOX);
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) {
      expect(pin.x).toBeGreaterThanOrEqual(0);
      expect(pin.x).toBeLessThanOrEqual(BOX.width);
      expect(pin.y).toBeGreaterThanOrEqual(0);
      expect(pin.y).toBeLessThanOrEqual(BOX.height);
    }
    // Merging may move photographs between pins but must never drop one.
    expect(pins.reduce((sum, pin) => sum + pin.count, 0)).toBe(12);
    expect(pins.reduce((sum, pin) => sum + pin.places, 0)).toBe(TAHOE.length);
  });

  it("merges or separates by the DRAWING, not by the data", () => {
    // Same coordinates, two questions: merging happens in pixels, not data.
    const trip = projectPlaces(TAHOE, BOX);
    const lakeOnly = projectPlaces(TAHOE.slice(2), BOX);
    expect(trip.pins).toHaveLength(3);
    expect(lakeOnly.pins).toHaveLength(3);
    expect(trip.pins.find((pin) => pin.places === 3)).toBeDefined();
  });

  it("draws north up and east right", () => {
    const pins = new Map(
      projectPlaces(TAHOE, BOX).pins.map((pin) => [pin.key, pin])
    );
    const ridge = pins.get("ridge")!;
    const home = pins.get("home")!;
    // North sits higher; a sign error here draws a plausible upside-down map.
    expect(ridge.y).toBeLessThan(home.y);
    // Tahoe is east of the Bay Area (-120.1 > -122.1).
    expect(ridge.x).toBeGreaterThan(home.x);
  });

  it("keeps one scale on both axes, so the shape is not stretched", () => {
    const pins = new Map(
      projectPlaces(TAHOE, BOX).pins.map((pin) => [pin.key, pin])
    );
    const home = pins.get("home")!;
    const city = pins.get("city")!;
    // Ground truth: dLat vertical, cosine-corrected dLng horizontal.
    const dLat = 37.7955 - 37.4419;
    const dLng = (-122.3937 - -122.143) * Math.cos((38.22 * Math.PI) / 180);
    const drawnRatio = Math.abs((city.x - home.x) / (city.y - home.y));
    expect(drawnRatio).toBeCloseTo(Math.abs(dLng / dLat), 1);
  });

  it("corrects longitude for latitude", () => {
    // 60°N: a longitude degree is half a latitude degree; uncorrected, square.
    const square: PlacePoint[] = [
      { key: "a", lat: 59.5, lng: 0, count: 1, name: null },
      { key: "b", lat: 60.5, lng: 0, count: 1, name: null },
      { key: "c", lat: 60, lng: -0.5, count: 1, name: null },
      { key: "d", lat: 60, lng: 0.5, count: 1, name: null },
    ];
    const pins = new Map(
      projectPlaces(square, { width: 400, height: 400 }).pins.map((pin) => [
        pin.key,
        pin,
      ])
    );
    const acrossPx = pins.get("d")!.x - pins.get("c")!.x;
    const downPx = pins.get("a")!.y - pins.get("b")!.y;
    expect(acrossPx / downPx).toBeCloseTo(0.5, 1);
  });

  it("merges places that would collide, keeping the biggest one's name", () => {
    // Two ledger rows ~11m apart: one dot on any trip-scale map.
    const twins: PlacePoint[] = [
      { key: "small", lat: 39.0021, lng: -120.1131, count: 1, name: "small" },
      { key: "big", lat: 39.0022, lng: -120.1132, count: 9, name: "big" },
      { key: "far", lat: 37.4419, lng: -122.143, count: 2, name: "far" },
    ];
    const { pins } = projectPlaces(twins, BOX);
    expect(pins).toHaveLength(2);
    const merged = pins.find((pin) => pin.places === 2)!;
    // The surviving name is the one with the photographs behind it.
    expect(merged.name).toBe("big");
    expect(merged.key).toBe("big");
    expect(merged.count).toBe(10);
  });

  it("draws one place without dividing by a zero span", () => {
    const one: PlacePoint[] = [
      { key: "only", lat: 39.0021, lng: -120.1131, count: 3, name: "only" },
    ];
    const { pins, scale, parallels } = projectPlaces(one, BOX);
    expect(pins).toHaveLength(1);
    expect(pins[0]!.x).toBeCloseTo(BOX.width / 2, 5);
    expect(pins[0]!.y).toBeCloseTo(BOX.height / 2, 5);
    expect(Number.isFinite(scale.km)).toBe(true);
    expect(scale.km).toBeGreaterThan(0);
    expect(parallels.length).toBeGreaterThan(0);
  });

  it("has nothing to say about an empty library", () => {
    const { pins, scale, meridians } = projectPlaces([], BOX);
    expect(pins).toStrictEqual([]);
    expect(meridians).toStrictEqual([]);
    expect(scale).toStrictEqual({ px: 0, km: 0 });
  });

  it("drops a place whose coordinates did not survive, and draws the rest", () => {
    const broken: PlacePoint[] = [
      ...TAHOE,
      { key: "bad", lat: Number.NaN, lng: 0, count: 1, name: null },
    ];
    const good = projectPlaces(TAHOE, BOX);
    const withBad = projectPlaces(broken, BOX);
    expect(withBad.pins).toHaveLength(good.pins.length);
    expect(withBad.pins.reduce((sum, pin) => sum + pin.count, 0)).toBe(12);
  });

  it("measures its own scale bar honestly", () => {
    const { scale, pins } = projectPlaces(TAHOE, BOX);
    const home = pins.find((pin) => pin.key === "home")!;
    const ridge = pins.find((pin) => pin.key === "ridge")!;
    // ~215km ground truth, not the projection's own arithmetic.
    const drawnPx = Math.hypot(ridge.x - home.x, ridge.y - home.y);
    const kmPerPx = scale.km / scale.px;
    expect(drawnPx * kmPerPx).toBeGreaterThan(180);
    expect(drawnPx * kmPerPx).toBeLessThan(250);
  });

  it("keeps the scale bar inside the box it was measured against", () => {
    const { scale } = projectPlaces(TAHOE, BOX);
    expect(scale.px).toBeLessThanOrEqual(BOX.width * 0.3);
  });
});

describe("what a pin stands for at the scale being drawn", () => {
  // Two places 200m apart, and two rows ~14m apart (the identity rung).
  const STREET: PlacePoint[] = [
    { key: "north", lat: 39.0018, lng: -120, count: 3, name: "North" },
    { key: "south", lat: 39, lng: -120, count: 1, name: "South" },
  ];
  const TWINS: PlacePoint[] = [
    { key: "a", lat: 39.0021, lng: -120.1131, count: 3, name: "A" },
    { key: "b", lat: 39.0022, lng: -120.1132, count: 1, name: "B" },
  ];
  const at = (kmPerPx: number, lat = 39.0009): MapCamera => ({
    lat,
    lng: -120,
    kmPerPx,
  });
  // Smaller than any drawn pin: measures the tier floor, not overlap.
  const DOT = { ...BOX, mergeDistance: 4 };

  it("climbs the ladder as the ground each pixel covers grows", () => {
    expect(mapTier(2)).toBe("countries");
    expect(mapTier(0.5)).toBe("countries");
    expect(mapTier(0.499)).toBe("cities");
    expect(mapTier(0.02)).toBe("cities");
    expect(mapTier(0.019)).toBe("spots");
    expect(["Countries", "Cities", "Spots"]).toStrictEqual(
      (["countries", "cities", "spots"] as const).map(tierNoun)
    );
  });

  it("keeps one street two spots and makes it one city", () => {
    // Same places, two scales: 2m/px keeps two pins; 20m/px + 1km floor → one.
    const spots = projectPlaces(STREET, { ...DOT, camera: at(0.002) });
    const cities = projectPlaces(STREET, { ...DOT, camera: at(0.02) });
    expect(spots.tier).toBe("spots");
    expect(cities.tier).toBe("cities");
    expect(spots.pins).toHaveLength(2);
    expect(cities.pins).toHaveLength(1);
    expect(cities.pins[0]?.places).toBe(2);
  });

  it("never splits two places the ledger itself cannot tell apart", () => {
    // 28px apart at 0.5m/px — pixel rules would over-split; the 50m floor refuses.
    const { pins, tier } = projectPlaces(TWINS, {
      ...DOT,
      camera: at(0.0005, 39.0021),
    });
    expect(tier).toBe("spots");
    expect(pins).toHaveLength(1);
    expect(pins[0]?.places).toBe(2);
  });

  it("groups identically in any box, so the phone and the browser agree", () => {
    // Stating the camera makes pin distance ground-truth, not plate-size:
    // phone and web must merge identically.
    const camera = at(0.02);
    const phone = projectPlaces(STREET, {
      width: 358,
      height: 322,
      mergeDistance: 76,
      camera,
    });
    const web = projectPlaces(STREET, {
      width: 640,
      height: 422,
      mergeDistance: 76,
      camera,
    });
    expect(phone.tier).toBe(web.tier);
    expect(
      phone.pins.map((pin) => [pin.key, pin.count, pin.places])
    ).toStrictEqual(web.pins.map((pin) => [pin.key, pin.count, pin.places]));
  });

  it("hands back the camera it drew through, fitted or given", () => {
    const fitted = projectPlaces(TAHOE, BOX);
    expect(fitted.camera).toStrictEqual(fitCamera(TAHOE, BOX));
    expect(fitted.tier).toBe(mapTier(fitted.camera.kmPerPx));
    const camera = at(0.05);
    expect(projectPlaces(TAHOE, { ...BOX, camera }).camera).toStrictEqual(
      camera
    );
    // Nothing to look at is not a camera at all.
    expect(fitCamera([], BOX)).toBeNull();
  });

  it("lets the drawing win while the pins are the wider fact", () => {
    // Threshold is max(pin width, floor), which makes the swap automatic.
    expect(tierMergeDistance("countries", 0.5, 76)).toBe(76);
    expect(tierMergeDistance("spots", 0.0005, 76)).toBe(100);
  });
});

describe("handing a basemap a viewport", () => {
  it("reads a scale off the slice of latitude a viewport shows", () => {
    // 1° of latitude down a 400px map is 111.32km over 400px.
    expect(kmPerPxForSpan(1, 400)).toBeCloseTo(0.2783, 4);
    // MapKit delta vs MapLibre bounds pair: either order, same scale.
    expect(kmPerPxForSpan(-1, 400)).toBe(kmPerPxForSpan(1, 400));
  });

  it("converts a scale into the zoom both SDKs understand", () => {
    // At the equator, zoom 0 is 156543m to the pixel and every step halves it.
    expect(
      tileZoomFor({ lat: 0, lng: 0, kmPerPx: 156.543_033_92 })
    ).toBeCloseTo(0, 6);
    expect(tileZoomFor({ lat: 0, lng: 0, kmPerPx: 78.271_516_96 })).toBeCloseTo(
      1,
      6
    );
    // Round trip: fitted camera → zoom → viewport back to scale.
    const camera = fitCamera(TAHOE, BOX)!;
    const zoom = tileZoomFor(camera);
    const metresPerPx =
      (156_543.033_92 * Math.cos((camera.lat * Math.PI) / 180)) / 2 ** zoom;
    expect(metresPerPx / 1000).toBeCloseTo(camera.kmPerPx, 6);
  });

  it("refuses a zoom no tile pyramid has", () => {
    // No reported viewport yet: clamp rather than return infinity.
    expect(tileZoomFor({ lat: 39, lng: -120, kmPerPx: 0 })).toBe(20);
    expect(tileZoomFor({ lat: 39, lng: -120, kmPerPx: 10_000 })).toBe(0);
  });
});

describe("finding the pin under a finger", () => {
  it("answers with the place a tapped coordinate belongs to", () => {
    // SDK reports the tapped coordinate; projection (not iOS-18 marker
    // events) picks the pin.
    const box = { width: 360, height: 360, mergeDistance: 76 };
    const camera = fitCamera(TAHOE, box)!;
    const { pins } = projectPlaces(TAHOE, { ...box, camera });
    const ridge = TAHOE[2]!;
    const tapped = projectAt(camera, box, ridge.lat, ridge.lng);
    expect(pinAtPoint(pins, tapped.x, tapped.y, 38)?.key).toBe("ridge");
  });

  it("puts a pin back on the ground it came from", () => {
    // Pixel↔ground must round-trip exactly or photographs slide off their
    // places while zooming.
    const box = { width: 360, height: 420, mergeDistance: 76 };
    const camera = fitCamera(TAHOE, box)!;
    const { pins } = projectPlaces(TAHOE, { ...box, camera });
    for (const pin of pins) {
      const back = coordAt(camera, box, pin.x, pin.y);
      const again = projectAt(camera, box, back.lat, back.lng);
      expect(again.x).toBeCloseTo(pin.x, 9);
      expect(again.y).toBeCloseTo(pin.y, 9);
    }
    // The pin that opens "ridge" sits on ridge's own coordinates.
    const ridge = pins.find((pin) => pin.key === "ridge")!;
    const where = coordAt(camera, box, ridge.x, ridge.y);
    expect(where.lat).toBeCloseTo(TAHOE[2]!.lat, 9);
    expect(where.lng).toBeCloseTo(TAHOE[2]!.lng, 9);
  });

  it("says nothing when the tap landed on the map rather than a pin", () => {
    const box = { width: 360, height: 360, mergeDistance: 76 };
    const { pins } = projectPlaces(TAHOE, box);
    expect(pinAtPoint(pins, -400, -400, 38)).toBeNull();
  });

  it("opens the nearer pin when two targets overlap", () => {
    const pins = projectPlaces(
      [
        { key: "near", lat: 39, lng: -120, count: 1, name: null },
        { key: "far", lat: 38, lng: -120, count: 1, name: null },
      ],
      { width: 400, height: 400, mergeDistance: 4 }
    ).pins;
    const near = pins.find((pin) => pin.key === "near")!;
    const far = pins.find((pin) => pin.key === "far")!;
    const between = { x: near.x, y: near.y + (far.y - near.y) * 0.4 };
    expect(pinAtPoint(pins, between.x, between.y, 999)?.key).toBe("near");
  });
});

describe("choosing a graticule step", () => {
  it("only ever returns 1, 2 or 5 times a power of ten", () => {
    for (const span of [0.004, 0.05, 0.4, 3, 17, 140, 900]) {
      const step = graticuleStep(span);
      const mantissa = step / 10 ** Math.floor(Math.log10(step));
      expect([1, 2, 5]).toContain(Math.round(mantissa));
    }
  });

  it("keeps the line count readable across five orders of magnitude", () => {
    for (const span of [0.01, 0.1, 1, 10, 100]) {
      const lines = span / graticuleStep(span);
      expect(lines).toBeGreaterThanOrEqual(2);
      expect(lines).toBeLessThanOrEqual(10);
    }
  });
});

describe("the photograph a pin is drawn as", () => {
  it("keeps the picture from the place most of the photographs came from", () => {
    // One dot: the surviving thumb must be the busy place's.
    const { pins } = projectPlaces(
      [
        {
          key: "quiet",
          lat: 39.0022,
          lng: -120.1132,
          count: 1,
          name: null,
          thumb: "quiet.png",
        },
        {
          key: "busy",
          lat: 39.0021,
          lng: -120.1131,
          count: 9,
          name: null,
          thumb: "busy.png",
        },
      ],
      BOX
    );
    expect(pins).toHaveLength(1);
    expect(pins[0]?.thumb).toBe("busy.png");
  });

  it("is null rather than undefined when a place has no photograph to show", () => {
    const { pins } = projectPlaces(
      [{ key: "a", lat: 39, lng: -120, count: 1, name: null }],
      BOX
    );
    expect(pins[0]?.thumb).toBeNull();
  });
});

describe("deciding whether a place has a name worth printing", () => {
  it("prints a name a person would recognise", () => {
    expect(readableName("Emerald Bay")).toBe("Emerald Bay");
    // Somewhere with a digit in its real name is still a real name.
    expect(readableName("Pier 39")).toBe("Pier 39");
  });

  it("refuses a coordinate wearing a name's clothes", () => {
    // Gazetteer-less default label; printed beside a pin it looks like an answer.
    expect(readableName("37.4419, -122.1430")).toBeNull();
    expect(readableName("39.0021,-120.1131")).toBeNull();
  });

  it("treats absent and blank as the same nothing", () => {
    expect(readableName(null)).toBeNull();
    expect(readableName(undefined)).toBeNull();
    expect(readableName("   ")).toBeNull();
  });
});
