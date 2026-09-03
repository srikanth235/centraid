import { DESTINATION_MARKS } from "@centraid/design";
import type { IconName } from "@centraid/design";

import type { ShellRoute } from "../../app-shell-context.js";
import type {
  ExperimentalCapability,
  ShellCapabilities,
} from "./capabilities.js";

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
  id: ShellPage;
  label: string;
  shortLabel?: string;
  icon: IconName;
  page: ShellPage;
  route: ShellRoute;
  requires?: ExperimentalCapability;
  retired?: true;
}

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

export const DEFAULT_PINS: readonly ShellPage[] = [
  "approvals",
  "insights",
  "atlas",
];

export const BAND_MAX_ITEMS = 5;

export type PinSet = Readonly<Record<string, boolean>>;

export function isPinned(pins: PinSet, id: ShellPage): boolean {
  return id === "home" || pins[id] === true;
}

export function visibleDestinations(
  capabilities: ShellCapabilities
): readonly LauncherDestination[] {
  return LAUNCHER_DESTINATIONS.filter(
    (d) =>
      d.retired !== true &&
      (d.requires === undefined || capabilities[d.requires])
  );
}

export function pinnedDestinations(
  pins: PinSet,
  capabilities: ShellCapabilities
): readonly LauncherDestination[] {
  return visibleDestinations(capabilities).filter((d) => isPinned(pins, d.id));
}

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
