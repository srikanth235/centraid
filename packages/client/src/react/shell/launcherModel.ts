import { DESTINATION_MARKS } from "@centraid/design";
import type { IconName } from "@centraid/design";

import type { ShellRoute } from "../../app-shell-context.js";
import type {
  ExperimentalCapability,
  ShellCapabilities,
} from "./capabilities.js";

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
// NOTHING IN THIS FILE CARRIES A HUE, and that is invariant 3 — "the shell owns
// no colour". The eight identity hues belong to the eight APPS
// (`packages/design/src/apps.ts`), and their whole value is the inference "a
// colour on screen means an app": if the shell spends them on its own
// destinations, the wheel stops meaning anything. Notifications wearing Photos'
// amber and Devices wearing People's violet is not a second use of a hue, it is
// the retirement of the rule.
//
// Every destination here is a place in the FRAME, so each renders as a plain
// glyph in `--text-faint` (`--text` while current), selection carried by the
// label weight and the 2px bar exactly as the binding layer draws it. That is
// also why `LauncherDestination` has no `colorKey` field at all rather than an
// optional one left unset — an optional hue is an invitation to fill it in.
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
  /** Where selecting it goes. */
  route: ShellRoute;
  /**
   * The gateway capability this destination needs (C1 — see
   * `capabilities.ts`). Absent means always available, which is what all but
   * three of them are.
   *
   * It is a field on the destination rather than a filter list beside this
   * array for the same reason `route` is: the launcher is the complete set of
   * places the shell can go, so what makes a place reachable belongs on the
   * place. A fourth gated destination is then one line here and nothing else.
   */
  requires?: ExperimentalCapability;
}

/**
 * Every destination, in launcher order.
 *
 * Order is the reading order of the All-apps sheet and, filtered by the pin
 * set, of the stem. It is deliberately stable: a launcher that reorders itself
 * by recency stops being a place you can point at from muscle memory.
 */
/* Marks come from `DESTINATION_MARKS` (`packages/design/src/destinations.ts`),
   never a literal here. The phone keeps its own destination list — different
   ids, different per-entry fields — and the one thing the two lists must agree
   on is which glyph stands for which place. Naming the icon in both files is
   how Analytics, Data and Devices each ended up wearing the wrong mark twice. */
export const LAUNCHER_DESTINATIONS: readonly LauncherDestination[] = [
  {
    icon: DESTINATION_MARKS.home,
    id: "home",
    label: "Home",
    page: "home",
    route: { kind: "home" },
  },
  {
    icon: DESTINATION_MARKS.assistant,
    id: "assistant",
    label: "Assistant",
    page: "assistant",
    route: { kind: "assistant" },
  },
  {
    icon: DESTINATION_MARKS.notifications,
    id: "approvals",
    label: "Notifications",
    page: "approvals",
    route: { kind: "approvals" },
    shortLabel: "Alerts",
  },
  {
    icon: DESTINATION_MARKS.automations,
    id: "automations",
    label: "Automations",
    page: "automations",
    requires: "automations",
    route: { kind: "automations" },
    shortLabel: "Autos",
  },
  {
    icon: DESTINATION_MARKS.connectors,
    id: "connectors",
    label: "Connectors",
    page: "connectors",
    requires: "connectors",
    route: { kind: "connectors" },
  },
  {
    icon: DESTINATION_MARKS.starred,
    id: "starred",
    label: "Starred",
    page: "starred",
    route: { kind: "starred" },
  },
  {
    icon: DESTINATION_MARKS.analytics,
    id: "insights",
    label: "Analytics",
    page: "insights",
    // Analytics counts automation runs and names them from the automation
    // list; both of its reads live behind the automations gate.
    requires: "automations",
    route: { kind: "insights" },
  },
  {
    icon: DESTINATION_MARKS.data,
    id: "atlas",
    label: "Data",
    page: "atlas",
    route: { kind: "atlas" },
  },
  {
    icon: DESTINATION_MARKS.devices,
    id: "household",
    label: "Devices",
    page: "household",
    route: { kind: "household" },
  },
  {
    icon: DESTINATION_MARKS.gateway,
    id: "gateway",
    label: "Gateway",
    page: "gateway",
    route: { kind: "gateway" },
  },
  {
    icon: DESTINATION_MARKS.storage,
    id: "storage",
    label: "Storage",
    page: "storage",
    route: { kind: "storage" },
  },
  {
    icon: DESTINATION_MARKS.settings,
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
   surface and ⌘K, not one of the places the frame goes.

   Three of these are gated (Automations, Connectors, Analytics) and they stay
   in the shipped set anyway: a pin is a member's arrangement, and
   `visibleDestinations` filters what a given gateway can show. Trimming the
   defaults instead would mean a gateway that opts in later starts with an
   emptier launcher than one that opted in first. */
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

/**
 * The destinations this gateway actually has, in launcher order.
 *
 * Every other reader here goes through this one, so a gated-off feature
 * disappears from the stem, the band, the All-apps sheet and the ⌘K palette
 * together — the failure mode being designed out is the sheet still listing a
 * place the stem stopped offering.
 *
 * The capabilities are PASSED IN and never read from a module global: this
 * file is data, and a model that fetched its own answer would be a second
 * detection site (C1) as well as untestable.
 */
export function visibleDestinations(
  capabilities: ShellCapabilities
): readonly LauncherDestination[] {
  return LAUNCHER_DESTINATIONS.filter(
    (d) => d.requires === undefined || capabilities[d.requires]
  );
}

/** The stem's items: pinned destinations this gateway has, in launcher order.
 *  Gating filters the VIEW, never the stored pin — turning a feature off is
 *  not the member unpinning it, and turning it back on restores the launcher
 *  they arranged. */
export function pinnedDestinations(
  pins: PinSet,
  capabilities: ShellCapabilities
): readonly LauncherDestination[] {
  return visibleDestinations(capabilities).filter((d) => isPinned(pins, d.id));
}

/**
 * The compact band's items plus how many pinned destinations did not fit.
 *
 * Overflow is not dropped — it moves behind "More", which opens the same
 * All-apps sheet. A band that silently loses a pinned app would make pinning
 * feel unreliable, which is worse than one extra tap.
 */
export function bandDestinations(
  pins: PinSet,
  capabilities: ShellCapabilities
): {
  items: readonly LauncherDestination[];
  overflow: number;
} {
  const all = pinnedDestinations(pins, capabilities);
  if (all.length <= BAND_MAX_ITEMS) return { items: all, overflow: 0 };
  // One slot goes to "More", so only four of the five carry apps.
  const shown = all.slice(0, BAND_MAX_ITEMS - 1);
  return { items: shown, overflow: all.length - shown.length };
}

/** Case-insensitive substring filter for the All-apps sheet. */
export function searchDestinations(
  query: string,
  capabilities: ShellCapabilities
): readonly LauncherDestination[] {
  const rows = visibleDestinations(capabilities);
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((d) => d.label.toLowerCase().includes(q));
}
