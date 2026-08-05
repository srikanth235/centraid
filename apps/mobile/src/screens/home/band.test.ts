// The mobile band's contract (the Binding Layer, invariant 1).
//
// Two things are worth asserting rather than trusting a comment for: the band
// carries the FRAME's destinations and never an app, and it never grows past
// five of them plus More. Both are rules a well-meaning change breaks silently
// — an app added "just for convenience", or a sixth destination that looks fine
// on a tablet and puts every tab under 44pt on a phone.
//
// `bandTabs` is now a function of the member's pinned places rather than a
// static list (./places), so most of this file feeds it different pin sets —
// the default (an out-of-box member), an empty set (nobody pinned anything,
// so only Home shows), and an over-full set (more than four pinned, which has
// to overflow rather than grow the band).
//
// Pure-logic checks only, matching this directory's discipline. `HomeBand.tsx`
// renders every tab through the SAME `<Tab>` component and the SAME
// `styles.tab` rule (`minHeight: metrics.row`, `flex: 1`), so proving the tab
// count here and `metrics.row >= 44` is proving the real on-screen floor rather
// than a disconnected assumption.

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

  it("shows Home, Alerts, Rules, Connectors and Analytics by default", () => {
    // The out-of-box pin set (./places#DEFAULT_PLACE_PINS) has to keep this
    // band unchanged from before places became pinnable — a member who never
    // opens All apps should never notice the model underneath it changed.
    expect(bandTabs(DEFAULT_PLACE_PINS).map((tab) => tab.short)).toStrictEqual([
      "Home",
      "Alerts",
      "Rules",
      "Connectors",
      "Analytics",
    ]);
  });

  it("holds at most 5 destinations, Home included", () => {
    expect(bandTabs(DEFAULT_PLACE_PINS)).toHaveLength(MAX_BAND_TABS);
    // Pinning every place still caps the band at five — the rest overflow to
    // More, exactly like a sixth pinned app overflows the desktop stem.
    expect(bandTabs(ALL_PLACE_IDS)).toHaveLength(MAX_BAND_TABS);
  });

  it("shows only Home when nothing is pinned", () => {
    expect(bandTabs([]).map((tab) => tab.id)).toStrictEqual(["home"]);
  });

  it("keeps the table's fixed order, never the pin order", () => {
    // Pinning Storage before Notifications must not move Storage ahead of it
    // — order is the table's, never the member's click order (:3470).
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
    // `styles.tab` sets `minHeight: metrics.row` for every tab, so sabotaging
    // `metrics.row` in packages/design is what a regression here looks like —
    // not a locally-duplicated literal.
    expect(metrics.row).toBeGreaterThanOrEqual(TOUCH_TARGET_FLOOR);
  });
});
