// The eleven places (the Binding Layer, v4 handoff — PLACES table).
//
// Four things worth asserting rather than trusting a comment for: the table
// really has eleven rows, Home is the only one pinned by law, the default pin
// set is exactly the six the handoff ships pinned, and the band derivation
// (`bandPlaces`) never lets a member's pin count push the compact band past
// its cap. Every one of these is a rule a well-meaning table edit — adding a
// twelfth place, or flipping a `pin` — could break silently.

import { describe, expect, it } from "vitest";

import {
  BAND_PLACE_SLOTS,
  DEFAULT_PLACE_PINS,
  PLACES,
  PLACE_COUNT,
  bandPlaces,
  getPlace,
  isPlacePinned,
  pinnedPlaces,
  searchPlaces,
} from "./places";

describe("the eleven places", () => {
  it("has exactly eleven rows, matching PLACE_COUNT", () => {
    expect(PLACES).toHaveLength(11);
    expect(PLACE_COUNT).toBe(11);
  });

  it("gives every place a distinct id, name and short label", () => {
    expect(new Set(PLACES.map((p) => p.id)).size).toBe(PLACES.length);
    for (const place of PLACES) {
      expect(place.name.length).toBeGreaterThan(0);
      expect(place.short.length).toBeGreaterThan(0);
      expect(place.what.length).toBeGreaterThan(0);
    }
  });

  it("pins Home by law, and nothing else", () => {
    const lawful = PLACES.filter((p) => p.law);
    expect(lawful.map((p) => p.id)).toStrictEqual(["home"]);
  });

  it("carries Home first", () => {
    expect(PLACES[0]?.id).toBe("home");
  });

  it("uses the exact short labels a 61px band tab needs", () => {
    // Two names do not fit a 61px tab (:3480): Notifications reads Alerts,
    // Automations reads Rules. Every other place's short label is its own
    // name — Connectors is short enough to stand as both.
    expect(getPlace("notifs").short).toBe("Alerts");
    expect(getPlace("autos").short).toBe("Rules");
    expect(getPlace("conn").short).toBe("Connectors");
    expect(getPlace("stats").short).toBe("Analytics");
  });

  it("defaults to the six places the handoff ships pinned", () => {
    expect(DEFAULT_PLACE_PINS).toStrictEqual([
      "notifs",
      "autos",
      "conn",
      "stats",
      "data",
      "devices",
    ]);
  });

  it("treats Home as pinned even with an empty pin list", () => {
    expect(isPlacePinned([], "home")).toBe(true);
    expect(isPlacePinned([], "starred")).toBe(false);
    expect(isPlacePinned(["starred"], "starred")).toBe(true);
  });

  it("orders pinned places by the table, not by pin order", () => {
    const pinned = pinnedPlaces(["storage", "notifs"]);
    expect(pinned.map((p) => p.id)).toStrictEqual([
      "home",
      "notifs",
      "storage",
    ]);
  });

  it("caps the band at Home plus four pinned places", () => {
    const allIds = PLACES.map((p) => p.id);
    const band = bandPlaces(allIds);
    expect(band).toHaveLength(1 + BAND_PLACE_SLOTS);
    expect(band[0]?.id).toBe("home");
    // The first four pinned places in table order, exactly what the compact
    // band spec calls out by name (:3480).
    expect(band.slice(1).map((p) => p.id)).toStrictEqual([
      "notifs",
      "autos",
      "conn",
      "stats",
    ]);
  });

  it("shows only Home in the band when nothing is pinned", () => {
    expect(bandPlaces([]).map((p) => p.id)).toStrictEqual(["home"]);
  });

  it("filters by name, case-insensitively", () => {
    expect(searchPlaces("connect").map((p) => p.id)).toStrictEqual(["conn"]);
    expect(searchPlaces("ANALYTICS").map((p) => p.id)).toStrictEqual(["stats"]);
    expect(searchPlaces("")).toStrictEqual(PLACES);
    expect(searchPlaces("nothing matches this")).toHaveLength(0);
  });

  it("never lists the Assistant — it is an app, not a place (:3482)", () => {
    expect(PLACES.some((p) => p.name === "Assistant")).toBe(false);
  });
});
