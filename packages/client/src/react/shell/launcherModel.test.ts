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

  it("has no catalogue destination — first-party apps are not acquired", () => {
    // Discover was a place you went to get what you did not have. Every bundled
    // app is installed at vault mount (#708), so there was nothing left to get:
    // Home's springboard opens on all eight, and the All-apps sheet arranges
    // them. Automation templates keep their own gallery — adopting one clones
    // into the code store, which really is an acquisition — but it is a detail
    // route off Automations, not a standing launcher row.
    expect(LAUNCHER_DESTINATIONS.some((d) => d.label === "Discover")).toBe(
      false
    );
  });

  it("gives no destination an identity hue — the shell owns no colour", () => {
    // Invariant 3. The eight identity hues belong to the eight APPS; a frame
    // destination that borrows one (Notifications in Photos' amber, Devices in
    // People's violet) does not extend the wheel, it retires it — a colour on
    // screen stops meaning "an app is here". Asserted over the whole list
    // rather than over Home alone, because the failure mode is a hue creeping
    // back onto one row at a time.
    for (const d of LAUNCHER_DESTINATIONS) {
      expect(Object.hasOwn(d, "colorKey"), `${d.id} declares a hue`).toBe(
        false
      );
    }
  });

  it("keeps Home in the launcher whatever the pin map says", () => {
    expect(isPinned({}, "home")).toBe(true);
    expect(isPinned({ home: false }, "home")).toBe(true);
    expect(isPinned({}, "connectors")).toBe(false);
  });

  it("ships every standing destination pinned, and lets the band overflow", () => {
    // This used to assert the default set FIT the band (`length + 1 <=
    // BAND_MAX_ITEMS`), which is what trimmed Connectors, Devices, Data and
    // Analytics out of the desktop stem — the band's budget deciding the
    // sidebar's contents. The stem scrolls and has no cap; the band's overflow
    // goes behind `More`, which is what `More` is for.
    for (const id of [
      "connectors",
      "household",
      "atlas",
      "insights",
    ] as const) {
      expect(DEFAULT_PINS).toContain(id);
    }
    // The band still obeys its own cap — it just reaches it now.
    const band = bandDestinations(pinsOf(...DEFAULT_PINS));
    expect(band.items).toHaveLength(BAND_MAX_ITEMS - 1);
    expect(band.overflow).toBeGreaterThan(0);
    // Nothing is lost: shown + overflow accounts for every pin, Home included.
    expect(band.items.length + band.overflow).toBe(DEFAULT_PINS.length + 1);
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
      const pins = pinsOf(
        "assistant",
        "approvals",
        "automations",
        "connectors",
        "insights",
        "starred"
      );
      const band = bandDestinations(pins);
      // Four apps plus More: a sixth tab would put every target under 44px,
      // which stops being a tap target.
      expect(band.items).toHaveLength(BAND_MAX_ITEMS - 1);
      expect(band.overflow).toBe(3);
      // Nothing is dropped — overflow accounts for every pinned destination.
      expect(band.items.length + band.overflow).toBe(
        pinnedDestinations(pins).length
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
