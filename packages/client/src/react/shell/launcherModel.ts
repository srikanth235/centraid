import { DESTINATION_MARKS } from "@centraid/design";
import type { IconName } from "@centraid/design";

import type { ShellRoute } from "../../app-shell-context.js";
import type {
  ExperimentalCapability,
  ShellCapabilities,
} from "./capabilities.js";

// The COMPLETE set of places the shell can go (#707): stem, All-apps sheet and
// ⌘K all read it, so a destination missing here is unreachable. Rows are named
// for what the member finds, never the internal model (#667) — `page` carries
// the internal key. NOTHING HERE CARRIES A HUE (invariant 3): identity hues
// belong to the apps, hence no `colorKey` field at all.

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
  /** Stable pin/test key, independent of the label. */
  id: ShellPage;
  label: string;
  shortLabel?: string;
  icon: IconName;
  page: ShellPage;
  route: ShellRoute;
  /** Capability gate (C1, `capabilities.ts`); absent means always available. */
  requires?: ExperimentalCapability;
  /** Surface merged into another's. The row stays because its id is a persisted
   *  pin key; `visibleDestinations` drops it from every view. Unifying the two
   *  ids is a pin-set migration, deliberately not done here. */
  retired?: true;
}

/* Order is the sheet's reading order and, filtered by pins, the stem's; keep it
   stable. Marks come from `DESTINATION_MARKS`, never a literal: the phone's own
   list must agree on which glyph stands for which place. */
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
    label: "Activity",
    page: "insights",
    // Both of Activity's reads live behind the automations gate.
    requires: "automations",
    route: { kind: "insights" },
  },
  {
    icon: DESTINATION_MARKS.data,
    id: "atlas",
    label: "Vault",
    page: "atlas",
    route: { kind: "atlas" },
  },
  {
    // Merged into Vault; the route still resolves, so an old pin and an old
    // deep link both land on the surviving surface.
    icon: DESTINATION_MARKS.devices,
    id: "household",
    label: "Vault",
    page: "household",
    retired: true,
    route: { kind: "atlas" },
  },
  {
    icon: DESTINATION_MARKS.gateway,
    id: "gateway",
    label: "System",
    page: "gateway",
    route: { kind: "gateway" },
  },
  {
    icon: DESTINATION_MARKS.settings,
    id: "settings",
    label: "Settings",
    page: "settings",
    route: { kind: "settings" },
  },
];

/* Home is absent because it is pinned by law (`isPinned`); Assistant because
   #707 settled it as a pinned APP, not a launcher row. */
export const DEFAULT_PINS: readonly ShellPage[] = [
  "approvals",
  "insights",
  "atlas",
];

/** Band cap INCLUDING Home; More is a sixth control, not a destination. */
export const BAND_MAX_ITEMS = 5;

export type PinSet = Readonly<Record<string, boolean>>;

/** Encoded here, not in the toggle, so stem, sheet and persistence agree. */
export function isPinned(pins: PinSet, id: ShellPage): boolean {
  return id === "home" || pins[id] === true;
}

/** Every other reader goes through this one, so a gated-off feature leaves stem,
 *  band, sheet and palette together. Capabilities are PASSED IN, never read from
 *  a module global — that would be a second detection site (C1). */
export function visibleDestinations(
  capabilities: ShellCapabilities
): readonly LauncherDestination[] {
  return LAUNCHER_DESTINATIONS.filter(
    (d) =>
      d.retired !== true &&
      (d.requires === undefined || capabilities[d.requires])
  );
}

/** Gating filters the VIEW, never the stored pin: turning a feature off is not
 *  the member unpinning it. */
export function pinnedDestinations(
  pins: PinSet,
  capabilities: ShellCapabilities
): readonly LauncherDestination[] {
  return visibleDestinations(capabilities).filter((d) => isPinned(pins, d.id));
}

/** Overflow is never dropped — it moves behind "More", which opens the same
 *  All-apps sheet. */
export function bandDestinations(
  pins: PinSet,
  capabilities: ShellCapabilities
): {
  items: readonly LauncherDestination[];
  overflow: number;
} {
  const all = pinnedDestinations(pins, capabilities);
  if (all.length <= BAND_MAX_ITEMS) return { items: all, overflow: 0 };
  const shown = all.slice(0, BAND_MAX_ITEMS);
  return { items: shown, overflow: all.length - shown.length };
}

export function searchDestinations(
  query: string,
  capabilities: ShellCapabilities
): readonly LauncherDestination[] {
  const rows = visibleDestinations(capabilities);
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((d) => d.label.toLowerCase().includes(q));
}
