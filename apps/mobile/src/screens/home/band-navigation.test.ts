// R-NY-1's stack invariant (#1015): switching Home band tabs never grows the
// root stack past Home + one place, whatever stack the press starts from.
import { describe, expect, it } from "vitest";

import type { BandTarget } from "./band";
import { ALL_APPS_SHEET, bandStack, placeRoute } from "./band-navigation";
import type { StackRoute } from "./band-navigation";
import { PLACES } from "./places";

const home: StackRoute = { key: "home-1", name: "Home" };

/** Every stack a band press can start from, deep ones included. */
const STARTS: Readonly<Record<string, readonly StackRoute[]>> = {
  "Home alone": [home],
  "a place over Home": [home, { key: "ins-1", name: "Insights" }],
  "a place pushed from a place": [
    home,
    { key: "data-1", name: "Data" },
    { key: "dev-1", name: "Devices" },
  ],
  "a rule's thread over Rules": [
    home,
    { key: "auto-1", name: "Automations" },
    { key: "auto-2", name: "Automations", params: { automationRef: "r" } },
  ],
  "a sub-page inside Settings": [
    home,
    { key: "set-1", name: "Settings", params: { screen: "PhoneStorage" } },
  ],
};

const TARGETS: readonly BandTarget[] = [
  ...PLACES.map((place) => place.id),
  "more",
];

describe("selecting a Home band tab", () => {
  it.each(Object.entries(STARTS))(
    "never grows the stack past Home + one place, from %s",
    (_, routes) => {
      for (const target of TARGETS) {
        const next = bandStack(routes, target);
        expect(next.routes.length).toBeLessThanOrEqual(2);
        expect(next.index).toBe(next.routes.length - 1);
        // The SAME Home: its key survives, so Home is not remounted and no
        // second Home is ever stacked.
        expect(next.routes[0]?.key).toBe("home-1");
        expect(
          next.routes.filter((route) => route.name === "Home")
        ).toHaveLength(1);
      }
    }
  );

  it("stays at Home + one place however many tabs are switched", () => {
    let routes: readonly StackRoute[] = [home];
    for (let press = 0; press < 40; press += 1) {
      const target = TARGETS[(press * 7) % TARGETS.length]!;
      routes = bandStack(routes, target).routes;
      expect(routes.length).toBeLessThanOrEqual(2);
    }
  });

  it("pops to Home for the Home tab", () => {
    expect(
      bandStack(STARTS["a place pushed from a place"]!, "home")
    ).toStrictEqual({ index: 0, routes: [home] });
  });

  it("returns to the one Home with the all-apps sheet for More", () => {
    const next = bandStack(STARTS["a place over Home"]!, "more");
    expect(next).toStrictEqual({
      index: 0,
      routes: [{ ...home, params: { sheet: ALL_APPS_SHEET } }],
    });
  });

  it("lands on the place's own route, over Home", () => {
    expect(bandStack([home], "storage").routes[1]).toStrictEqual({
      name: "Settings",
      params: { screen: "PhoneStorage" },
    });
    expect(bandStack([home], "stats").routes[1]).toStrictEqual({
      name: "Insights",
    });
  });

  it("puts a fresh Home underneath when a deep link left none", () => {
    const next = bandStack(
      [{ key: "set-1", name: "Settings", params: { screen: "Approvals" } }],
      "data"
    );
    expect(next.routes).toStrictEqual([{ name: "Home" }, { name: "Data" }]);
  });

  it("routes every place somewhere", () => {
    for (const place of PLACES) {
      if (place.id === "home") continue;
      expect(placeRoute(place.id).name).toBeTruthy();
    }
  });
});
