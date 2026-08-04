import type { ColorKey, IconName } from "@centraid/design";

import type { ShellRoute } from "../../app-shell-context.js";

// The launcher's information architecture, as data (issue #707).
//
// This replaces navModel.ts. The sidebar's three zones are gone: the stem
// holds the product mark, Search, and a launcher of PINNED destinations, and
// nothing else. Everything the launcher does not show is still reachable — the
// All-apps sheet lists every destination in this file, pinned or not, and the
// ⌘K palette indexes the same list. So this module has one job it did not have
// before: it is the COMPLETE set of places the shell can go. A destination
// that is not here is unreachable.
//
// Naming rule (carried over from #667): a row is named for what the member
// finds there, never for the internal model. "Devices", not "Household";
// "Data", not "Vault Atlas"; "Analytics", not "Insights". `page` still carries
// the internal key, so route highlighting is unaffected by what the label says.
//
// Hues are IDENTITY, not state: they tint the icon chip and paint the 2px
// selection bar, and they never reach a control. `Home` deliberately declares
// none — the launcher's own root is not an app, so it renders in `--text-soft`
// (the brief's "Home — none").
//
// Discover is NOT in this list, and its absence is the point (issue #708). A
// catalogue is a place you go to acquire what you do not have; every first-party
// app now ships installed, so there was nothing left there to acquire. The
// handoff's Home is two tiers — a springboard of content tiles and the All-apps
// sheet — and neither is a store. Automation templates are a different thing and
// keep their own gallery (`{ kind: "templates" }`, off the Automations overview):
// those still clone into the vault's code store, so adopting one really is an
// acquisition.

/** Route-highlight key. One per destination the stem/sheet can select. */
export type ShellPage =
  | "home"
  | "assistant"
  | "insights"
  | "starred"
  | "automations"
  | "connectors"
  | "approvals"
  | "gateway"
  | "household"
  | "storage"
  | "atlas"
  | "settings";

export interface LauncherDestination {
  /** Stable identity for keys, pins, and tests; independent of the label. */
  id: ShellPage;
  label: string;
  /** Band label. The compact band is 1/5th of a phone wide — a long name
   *  there truncates to nothing, so a destination whose label does not fit
   *  declares a shorter one rather than being ellipsised. */
  shortLabel?: string;
  icon: IconName;
  page: ShellPage;
  /** Identity hue slot. Absent = no hue at all (Home). */
  colorKey?: ColorKey;
  /** Where selecting it goes. */
  route: ShellRoute;
}

/**
 * Every destination, in launcher order.
 *
 * Order is the reading order of the All-apps sheet and, filtered by the pin
 * set, of the stem. It is deliberately stable: a launcher that reorders itself
 * by recency stops being a place you can point at from muscle memory.
 */
export const LAUNCHER_DESTINATIONS: readonly LauncherDestination[] = [
  {
    icon: "Home",
    id: "home",
    label: "Home",
    page: "home",
    route: { kind: "home" },
  },
  {
    colorKey: "rose",
    icon: "Sparkle",
    id: "assistant",
    label: "Assistant",
    page: "assistant",
    route: { kind: "assistant" },
  },
  {
    colorKey: "amber",
    icon: "Bell",
    id: "approvals",
    label: "Notifications",
    page: "approvals",
    route: { kind: "approvals" },
    shortLabel: "Alerts",
  },
  {
    colorKey: "forest",
    icon: "Bolt",
    id: "automations",
    label: "Automations",
    page: "automations",
    route: { kind: "automations" },
    shortLabel: "Autos",
  },
  {
    colorKey: "teal",
    icon: "Plug",
    id: "connectors",
    label: "Connectors",
    page: "connectors",
    route: { kind: "connectors" },
  },
  {
    colorKey: "ochre",
    icon: "Star",
    id: "starred",
    label: "Starred",
    page: "starred",
    route: { kind: "starred" },
  },
  {
    colorKey: "indigo",
    icon: "Activity",
    id: "insights",
    label: "Analytics",
    page: "insights",
    route: { kind: "insights" },
  },
  {
    colorKey: "slate",
    icon: "Folder",
    id: "atlas",
    label: "Data",
    page: "atlas",
    route: { kind: "atlas" },
  },
  {
    colorKey: "violet",
    icon: "Monitor",
    id: "household",
    label: "Devices",
    page: "household",
    route: { kind: "household" },
  },
  {
    colorKey: "slate",
    icon: "Cellular",
    id: "gateway",
    label: "Gateway",
    page: "gateway",
    route: { kind: "gateway" },
  },
  {
    colorKey: "teal",
    icon: "Save",
    id: "storage",
    label: "Storage",
    page: "storage",
    route: { kind: "storage" },
  },
  {
    icon: "Settings",
    id: "settings",
    label: "Settings",
    page: "settings",
    route: { kind: "settings" },
  },
];

/**
 * The pin set a member starts with.
 *
 * This was four (plus Home), sized so the compact band never overflowed on
 * first run. That optimised the wrong surface: the DESKTOP stem is where the
 * launcher actually lives, it scrolls rather than caps, and trimming to the
 * band's budget is what silently dropped Connectors, Devices, Data and
 * Analytics out of the sidebar — four places that had standing rows before
 * #707 and that a member has no reason to expect behind a sheet.
 *
 * Overflow on the band was never the failure it was treated as: `More` exists
 * for exactly this, opens the same All-apps sheet, and the cap logic already
 * handles it. So the default is now the full working set, and the band shows
 * Home plus the first four with the rest behind `More`.
 *
 * Home is not listed: it is pinned by law (see `isPinned`), the way a browser
 * cannot unpin its own back button.
 */
/* Assistant is deliberately absent: #707 settled it as a PINNED APP, not a
   standing launcher row — it is a thing you talk to, reachable from the app
   surface and ⌘K, not one of the places the frame goes. */
export const DEFAULT_PINS: readonly ShellPage[] = [
  "approvals",
  "automations",
  "connectors",
  "insights",
  "atlas",
  "household",
];

/** The compact band's hard cap, INCLUDING Home. A sixth slot would put every
 *  tab under the 44px floor, which stops being a tap target. */
export const BAND_MAX_ITEMS = 5;

export type PinSet = Readonly<Record<string, boolean>>;

/** Home is always in the launcher; every other destination is the member's
 *  call. Encoded here rather than in the toggle so the stem, the sheet, and
 *  the persistence layer cannot disagree about it. */
export function isPinned(pins: PinSet, id: ShellPage): boolean {
  return id === "home" || pins[id] === true;
}

/** The stem's items: pinned destinations, in launcher order. */
export function pinnedDestinations(
  pins: PinSet
): readonly LauncherDestination[] {
  return LAUNCHER_DESTINATIONS.filter((d) => isPinned(pins, d.id));
}

/**
 * The compact band's items plus how many pinned destinations did not fit.
 *
 * Overflow is not dropped — it moves behind "More", which opens the same
 * All-apps sheet. A band that silently loses a pinned app would make pinning
 * feel unreliable, which is worse than one extra tap.
 */
export function bandDestinations(pins: PinSet): {
  items: readonly LauncherDestination[];
  overflow: number;
} {
  const all = pinnedDestinations(pins);
  if (all.length <= BAND_MAX_ITEMS) return { items: all, overflow: 0 };
  // One slot goes to "More", so only four of the five carry apps.
  const shown = all.slice(0, BAND_MAX_ITEMS - 1);
  return { items: shown, overflow: all.length - shown.length };
}

/** Case-insensitive substring filter for the All-apps sheet. */
export function searchDestinations(
  query: string
): readonly LauncherDestination[] {
  const q = query.trim().toLowerCase();
  if (!q) return LAUNCHER_DESTINATIONS;
  return LAUNCHER_DESTINATIONS.filter((d) => d.label.toLowerCase().includes(q));
}
