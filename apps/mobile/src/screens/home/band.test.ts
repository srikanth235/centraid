// Band contract (Binding Layer invariant 1): FRAME destinations only, max
// five plus More; these checks pin the real touch floor.

import { describe, expect, it } from "vitest";

import { apps, metrics } from "@centraid/design";

import { MAX_BAND_TABS, bandTabs } from "./band";
import { DEFAULT_PLACE_PINS, PLACES } from "./places";
import type { PlaceId } from "./places";

const TOUCH_TARGET_FLOOR = 44;
const ALL_PLACE_IDS: readonly PlaceId[] = PLACES.map((p) => p.id);

describe("the mobile band", () => {
  it("carries Home first, out of the box", () => {
    const tabs = bandTabs(DEFAULT_PLACE_PINS);
    expect(tabs[0]?.id).toBe("home");
  });

  it("shows the v10 Origin destinations by default", () => {
    expect(bandTabs(DEFAULT_PLACE_PINS).map((tab) => tab.short)).toStrictEqual([
      "Home",
      "Alerts",
      "Activity",
      "Vault",
    ]);
  });

  it("holds at most 5 destinations, Home included", () => {
    expect(bandTabs(DEFAULT_PLACE_PINS)).toHaveLength(4);
    // Standing More sits outside this list.
    expect(bandTabs(DEFAULT_PLACE_PINS).length + 1).toBe(5);
    // Pinning every place still caps at five; rest overflows to More.
    expect(bandTabs(ALL_PLACE_IDS)).toHaveLength(MAX_BAND_TABS);
    expect(bandTabs(ALL_PLACE_IDS).length + 1).toBe(6);
  });

  it("lets one additional pin fill the fifth slot without displacing More", () => {
    expect(bandTabs([...DEFAULT_PLACE_PINS, "autos"])).toHaveLength(5);
    expect(
      bandTabs([...DEFAULT_PLACE_PINS, "autos"]).map((tab) => tab.short)
    ).toStrictEqual(["Home", "Alerts", "Activity", "Vault", "Rules"]);
  });

  it("shows only Home when nothing is pinned", () => {
    expect(bandTabs([]).map((tab) => tab.id)).toStrictEqual(["home"]);
  });

  it("keeps the table's fixed order, never the pin order", () => {
    // Order is the table's, never the member's click order (:3470).
    const tabs = bandTabs(["storage", "notifs"]);
    expect(tabs.map((tab) => tab.id)).toStrictEqual([
      "home",
      "notifs",
      "storage",
    ]);
  });

  it("names no installed app — apps live on Home and in All apps", () => {
    const appNames = new Set(apps.map((app) => app.name.toLowerCase()));
    const appIds = new Set<string>(apps.map((app) => app.id));
    for (const tab of bandTabs(ALL_PLACE_IDS)) {
      expect(appNames.has(tab.name.toLowerCase())).toBe(false);
      expect(appIds.has(tab.id)).toBe(false);
    }
  });

  it("gives every tab a distinct id and a label", () => {
    const tabs = bandTabs(ALL_PLACE_IDS);
    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(tabs.length);
    for (const tab of tabs) {
      expect(tab.name.length).toBeGreaterThan(0);
      expect(tab.short.length).toBeGreaterThan(0);
    }
  });

  it("keeps the shared row metric at least a 44pt touch target", () => {
    // Sabotaging metrics.row in design is the regression shape.
    expect(metrics.row).toBeGreaterThanOrEqual(TOUCH_TARGET_FLOOR);
  });
});
