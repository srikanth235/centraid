import { describe, expect, it } from "vitest";

import {
  ASSISTANT_ID,
  DEFAULT_PINS,
  MAX_PINS,
  buildAllEntries,
  buildBandTabs,
} from "./band";
import { buildLauncherItems } from "./catalog";

const items = buildLauncherItems([]);

describe(buildBandTabs, () => {
  it("resolves the default pins to five ordered tabs, Assistant included", () => {
    const tabs = buildBandTabs(DEFAULT_PINS, items);
    expect(tabs).toHaveLength(MAX_PINS);
    expect(tabs.map((tab) => tab.id)).toStrictEqual(DEFAULT_PINS);
    const assistant = tabs.find((tab) => tab.id === ASSISTANT_ID);
    expect(assistant?.color).toBeUndefined();
    expect(assistant?.installed).toBe(true);
  });

  it("carries the app's identity hue for an ordinary app tab", () => {
    const tabs = buildBandTabs(["photos"], items);
    expect(tabs[0]?.color).toBeTruthy();
    expect(tabs[0]?.name).toBe("Photos");
  });

  it("drops a pinned id that no longer resolves to a live app", () => {
    const tabs = buildBandTabs(["photos", "ghost-app"], items);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.id).toBe("photos");
  });

  it("never exceeds the 5-tab cap even if more ids are pinned", () => {
    const overfull = [...DEFAULT_PINS, "notes", "people"];
    expect(buildBandTabs(overfull, items)).toHaveLength(MAX_PINS);
  });
});

describe(buildAllEntries, () => {
  it("lists Assistant first, then the whole catalog, uncapped", () => {
    const entries = buildAllEntries(items);
    expect(entries[0]?.id).toBe(ASSISTANT_ID);
    expect(entries).toHaveLength(items.length + 1);
    expect(entries.length).toBeGreaterThan(MAX_PINS);
  });
});
