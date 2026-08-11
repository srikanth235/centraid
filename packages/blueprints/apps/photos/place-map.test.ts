import { describe, expect, it } from "vitest";

import type { PlacePoint } from "./place-map.ts";
import { graticuleStep, projectPlaces, readableName } from "./place-map.ts";

const BOX = { width: 600, height: 360 };

/** The seeded Tahoe roll, which is also what the shelf renders. */
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
    // Merging moves photographs between pins; it must never drop one.
    expect(pins.reduce((sum, pin) => sum + pin.count, 0)).toBe(12);
    expect(pins.reduce((sum, pin) => sum + pin.places, 0)).toBe(TAHOE.length);
  });

  it("merges or separates by the DRAWING, not by the data", () => {
    // The three Tahoe places sit within ~5km of each other. On a map wide
    // enough to also hold the Bay Area they are one dot, and on a map of the
    // lake alone they are three — same coordinates, different question. This
    // is the whole reason merging happens in pixels.
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
    // Tahoe is north of the Bay Area, so it must sit higher on the page —
    // the sign error this catches produces a map that looks fine and is
    // upside down.
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
    // Ground truth between Palo Alto and the city: latitude degrees for the
    // vertical, cosine-corrected longitude for the horizontal.
    const dLat = 37.7955 - 37.4419;
    const dLng = (-122.3937 - -122.143) * Math.cos((38.22 * Math.PI) / 180);
    const drawnRatio = Math.abs((city.x - home.x) / (city.y - home.y));
    expect(drawnRatio).toBeCloseTo(Math.abs(dLng / dLat), 1);
  });

  it("corrects longitude for latitude", () => {
    // One degree each way at 60°N, where a longitude degree is half a
    // latitude degree. Uncorrected, these would draw as a square.
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
    // Two rows in the ledger ~11m apart: one dot on any map holding a trip.
    const twins: PlacePoint[] = [
      { key: "small", lat: 39.0021, lng: -120.1131, count: 1, name: "small" },
      { key: "big", lat: 39.0022, lng: -120.1132, count: 9, name: "big" },
      { key: "far", lat: 37.4419, lng: -122.143, count: 2, name: "far" },
    ];
    const { pins } = projectPlaces(twins, BOX);
    expect(pins).toHaveLength(2);
    const merged = pins.find((pin) => pin.places === 2)!;
    // The surviving name is the one with the photographs behind it, not
    // whichever was read first.
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
    // Palo Alto to the west shore is ~215km; check the bar's km-per-pixel
    // against that known distance rather than against the projection's own
    // arithmetic, which would only prove it agrees with itself.
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
    // Two places close enough to be one dot. The surviving thumb has to be
    // the busy place's, or a merged pin shows a picture from the corner of
    // itself that almost nothing was taken in.
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
    // The default label until a gazetteer is installed. Printing it beside a
    // pin looks like an answer and is not one.
    expect(readableName("37.4419, -122.1430")).toBeNull();
    expect(readableName("39.0021,-120.1131")).toBeNull();
  });

  it("treats absent and blank as the same nothing", () => {
    expect(readableName(null)).toBeNull();
    expect(readableName(undefined)).toBeNull();
    expect(readableName("   ")).toBeNull();
  });
});
