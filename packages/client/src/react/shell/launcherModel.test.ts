import { describe, expect, it } from "vitest";

import { CAPABILITIES_OFF, CAPABILITIES_ON } from "./capabilities.js";
import {
  BAND_MAX_ITEMS,
  bandDestinations,
  DEFAULT_PINS,
  isPinned,
  LAUNCHER_DESTINATIONS,
  pinnedDestinations,
  searchDestinations,
  visibleDestinations,
} from "./launcherModel.js";
import type { ShellPage } from "./launcherModel.js";

const pinsOf = (...ids: ShellPage[]): Record<string, boolean> =>
  Object.fromEntries(ids.map((id) => [id, true]));

describe("the launcher model", () => {
  it("is the COMPLETE set of places the shell can go", () => {
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
        "atlas",
        "settings",
      ])
    );
    expect(ids).toHaveLength(new Set(ids).size);
  });

  it("has no catalogue destination — first-party apps are not acquired", () => {
    expect(LAUNCHER_DESTINATIONS.some((d) => d.label === "Discover")).toBe(
      false
    );
  });

  it("gives no destination an identity hue — the shell owns no colour", () => {
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

  it("pins the four questions and keeps setup and diagnostics behind More", () => {
    expect(DEFAULT_PINS).toStrictEqual(["approvals", "insights", "atlas"]);
    for (const id of [
      "automations",
      "connectors",
      "household",
      "gateway",
    ] as const)
      expect(DEFAULT_PINS).not.toContain(id);
    const band = bandDestinations(pinsOf(...DEFAULT_PINS), CAPABILITIES_ON);
    expect(band.items.map((destination) => destination.label)).toStrictEqual([
      "Home",
      "Notifications",
      "Activity",
      "Vault",
    ]);
    expect(band.overflow).toBe(0);
    expect(band.items.length + band.overflow).toBe(DEFAULT_PINS.length + 1);
  });

  it("orders the stem by the model, not by recency", () => {
    const pins = pinsOf("settings", "assistant");
    const order = pinnedDestinations(pins, CAPABILITIES_ON).map((d) => d.id);
    expect(order).toStrictEqual(["home", "assistant", "settings"]);
  });

  describe("the compact band", () => {
    it("shows every pinned destination when they fit", () => {
      const band = bandDestinations(
        pinsOf("assistant", "approvals"),
        CAPABILITIES_ON
      );
      expect(band.items.map((d) => d.id)).toStrictEqual([
        "home",
        "assistant",
        "approvals",
      ]);
      expect(band.overflow).toBe(0);
    });

    it("never exceeds five destinations, and reports what More is holding", () => {
      const pins = pinsOf(
        "assistant",
        "approvals",
        "automations",
        "connectors",
        "insights",
        "starred"
      );
      const band = bandDestinations(pins, CAPABILITIES_ON);
      expect(band.items).toHaveLength(BAND_MAX_ITEMS);
      expect(band.overflow).toBe(2);
      expect(band.items.length + band.overflow).toBe(
        pinnedDestinations(pins, CAPABILITIES_ON).length
      );
    });

    it("gives every band item a label short enough to survive a sixth of a phone", () => {
      for (const d of LAUNCHER_DESTINATIONS) {
        const shown = d.shortLabel ?? d.label;
        expect(shown.length, `${d.id} band label`).toBeLessThanOrEqual(11);
      }
    });
  });

  describe("the All-apps filter", () => {
    it("lists everything when the query is empty", () => {
      expect(searchDestinations("  ", CAPABILITIES_ON)).toStrictEqual(
        LAUNCHER_DESTINATIONS.filter((d) => d.retired !== true)
      );
    });

    it("matches on the label a member actually reads, case-insensitively", () => {
      expect(
        searchDestinations("activity", CAPABILITIES_ON).map((d) => d.id)
      ).toStrictEqual(["insights"]);
      expect(searchDestinations("COPIES", CAPABILITIES_ON)).toHaveLength(0);
      expect(
        searchDestinations("vault", CAPABILITIES_ON).map((d) => d.id)
      ).toStrictEqual(["atlas"]);
    });

    it("keeps the retired id resolvable, and out of every view", () => {
      const retired = LAUNCHER_DESTINATIONS.find((d) => d.id === "household");
      expect(retired?.retired).toBe(true);
      expect(retired?.route).toStrictEqual({ kind: "atlas" });
      expect(
        visibleDestinations(CAPABILITIES_ON).map((d) => d.id)
      ).not.toContain("household");
      expect(
        pinnedDestinations(pinsOf("household"), CAPABILITIES_ON).map(
          (d) => d.id
        )
      ).toStrictEqual(["home"]);
    });

    it("returns nothing for a query that matches nothing", () => {
      expect(searchDestinations("zzzz", CAPABILITIES_ON)).toHaveLength(0);
    });

    it("does not list a destination this gateway cannot serve", () => {
      expect(searchDestinations("automations", CAPABILITIES_OFF)).toHaveLength(
        0
      );
    });
  });

  describe("the experimental capability gates (C1)", () => {
    it("hides automations, its analytics, and connectors when the gateway offers neither", () => {
      const ids = visibleDestinations(CAPABILITIES_OFF).map((d) => d.id);
      expect(ids).not.toContain("automations");
      expect(ids).not.toContain("connectors");
      expect(ids).not.toContain("insights");
      expect(ids).toContain("home");
      expect(ids).toContain("approvals");
      expect(ids).toContain("atlas");
    });

    it("gates the two features independently", () => {
      const autosOnly = visibleDestinations({
        automations: true,
        connectors: false,
      }).map((d) => d.id);
      expect(autosOnly).toContain("automations");
      expect(autosOnly).toContain("insights");
      expect(autosOnly).not.toContain("connectors");

      const connsOnly = visibleDestinations({
        automations: false,
        connectors: true,
      }).map((d) => d.id);
      expect(connsOnly).toContain("connectors");
      expect(connsOnly).not.toContain("automations");
    });

    it("filters the view, never the member's pins", () => {
      const pins = pinsOf(...DEFAULT_PINS, "automations");
      expect(
        pinnedDestinations(pins, CAPABILITIES_OFF).map((d) => d.id)
      ).not.toContain("automations");
      expect(
        pinnedDestinations(pins, CAPABILITIES_ON).map((d) => d.id)
      ).toContain("automations");
      expect(pins.automations).toBe(true);
    });

    it("frees band slots rather than leaving a gap where a gated tab stood", () => {
      const pins = pinsOf(...DEFAULT_PINS);
      const full = bandDestinations(pins, CAPABILITIES_ON);
      const gated = bandDestinations(pins, CAPABILITIES_OFF);
      expect(full.overflow).toBe(gated.overflow);
      expect(gated.items.map((d) => d.id)).not.toContain("connectors");
      expect(gated.items.length + gated.overflow).toBe(
        pinnedDestinations(pins, CAPABILITIES_OFF).length
      );
    });
  });
});
