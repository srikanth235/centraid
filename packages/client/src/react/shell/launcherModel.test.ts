import { describe, expect, it } from "vitest";

import {
  BAND_MAX_ITEMS,
  bandDestinations,
  DEFAULT_PINS,
  isPinned,
  LAUNCHER_DESTINATIONS,
  pinnedDestinations,
  searchDestinations,
} from "./launcherModel.js";
import type { ShellPage } from "./launcherModel.js";

const pinsOf = (...ids: ShellPage[]): Record<string, boolean> =>
  Object.fromEntries(ids.map((id) => [id, true]));

describe("the launcher model", () => {
  it("is the COMPLETE set of places the shell can go", () => {
    // The stem shows only what is pinned, so anything missing from this list
    // is unreachable — there is no second table of destinations any more.
    const ids = LAUNCHER_DESTINATIONS.map((d) => d.id);
    expect(new Set(ids)).toStrictEqual(
      new Set([
        "home",
        "assistant",
        "insights",
        "discover",
        "starred",
        "automations",
        "connectors",
        "approvals",
        "gateway",
        "household",
        "storage",
        "atlas",
        "settings",
      ])
    );
    expect(ids).toHaveLength(new Set(ids).size);
  });

  it("gives Home no identity hue — the launcher's root is not an app", () => {
    const home = LAUNCHER_DESTINATIONS.find((d) => d.id === "home");
    expect(home?.colorKey).toBeUndefined();
    // Every other destination declares one, so the icon chips read as
    // identity rather than as decoration on some rows and not others.
    for (const d of LAUNCHER_DESTINATIONS) {
      if (d.id === "home" || d.id === "settings") continue;
      expect(d.colorKey, `${d.id} declares a hue`).toBeDefined();
    }
  });

  it("keeps Home in the launcher whatever the pin map says", () => {
    expect(isPinned({}, "home")).toBe(true);
    expect(isPinned({ home: false }, "home")).toBe(true);
    expect(isPinned({}, "connectors")).toBe(false);
  });

  it("ships a default pin set the compact band can actually hold", () => {
    // Home is pinned by law and takes one of the five slots.
    expect(DEFAULT_PINS.length + 1).toBeLessThanOrEqual(BAND_MAX_ITEMS);
  });

  it("orders the stem by the model, not by recency", () => {
    const pins = pinsOf("settings", "assistant");
    const order = pinnedDestinations(pins).map((d) => d.id);
    // Launcher order, regardless of the order the pins were written in: a
    // launcher that re-sorts itself stops being a place you can point at.
    expect(order).toStrictEqual(["home", "assistant", "settings"]);
  });

  describe("the compact band", () => {
    it("shows every pinned destination when they fit", () => {
      const band = bandDestinations(pinsOf("assistant", "approvals"));
      expect(band.items.map((d) => d.id)).toStrictEqual([
        "home",
        "assistant",
        "approvals",
      ]);
      expect(band.overflow).toBe(0);
    });

    it("never exceeds five slots, and reports what More is holding", () => {
      const band = bandDestinations(
        pinsOf(
          "assistant",
          "approvals",
          "automations",
          "connectors",
          "discover",
          "starred"
        )
      );
      // Four apps plus More: a sixth tab would put every target under 44px,
      // which stops being a tap target.
      expect(band.items).toHaveLength(BAND_MAX_ITEMS - 1);
      expect(band.overflow).toBe(3);
      // Nothing is dropped — overflow accounts for every pinned destination.
      expect(band.items.length + band.overflow).toBe(
        pinnedDestinations(
          pinsOf(
            "assistant",
            "approvals",
            "automations",
            "connectors",
            "discover",
            "starred"
          )
        ).length
      );
    });

    it("gives every band item a label short enough to survive a fifth of a phone", () => {
      for (const d of LAUNCHER_DESTINATIONS) {
        const shown = d.shortLabel ?? d.label;
        expect(shown.length, `${d.id} band label`).toBeLessThanOrEqual(11);
      }
    });
  });

  describe("the All-apps filter", () => {
    it("lists everything when the query is empty", () => {
      expect(searchDestinations("  ")).toStrictEqual(LAUNCHER_DESTINATIONS);
    });

    it("matches on the label a member actually reads, case-insensitively", () => {
      // `insights` is the internal key; "Analytics" is the word on screen.
      expect(searchDestinations("analytics").map((d) => d.id)).toStrictEqual([
        "insights",
      ]);
      expect(searchDestinations("DEVICES").map((d) => d.id)).toStrictEqual([
        "household",
      ]);
    });

    it("returns nothing for a query that matches nothing", () => {
      expect(searchDestinations("zzzz")).toHaveLength(0);
    });
  });
});
