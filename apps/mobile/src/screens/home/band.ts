// Pure list-building for the mobile navigation band (issue #707 Phase 5).
// No React/navigation/storage imports, same discipline as ./catalog — the
// merge rule stays unit-testable and the tab shape lives in exactly one
// place. ./band-pins layers the persisted pin list on top of this module.

import type { IconName } from "@centraid/design";

import type { LauncherItem } from "./catalog";

// The band's hard ceiling (invariant 1: 5 apps + More, never more — a tab
// below 44px on a 6th+ slot stops being a reliable tap target).
export const MAX_PINS = 5;

/** Assistant is not in the app catalog (it has no identity hue to register),
 *  but it is always one of the band's five slots by default. */
export const ASSISTANT_ID = "assistant";

// The band's out-of-the-box five. Photos and Docs are the two heaviest-traffic
// content apps, Agenda and Tasks answer "what's next", and Assistant (an
// ordinary ink slot — issue #707 Decision §3, never raised or teal) rounds out
// the row. Notes, People, Locker and Tally start unpinned, one tap away
// through More.
export const DEFAULT_PINS: readonly string[] = [
  "photos",
  "docs",
  "agenda",
  "tasks",
  ASSISTANT_ID,
];

/** De-duplicate and cap at `MAX_PINS`, preserving the given order. */
export function sanitizePins(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id) || out.length >= MAX_PINS) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export interface BandTab {
  id: string;
  name: string;
  icon: IconName;
  /** Identity hue hex. `undefined` renders the ordinary ink treatment —
   *  Assistant and More, neither of which owns a hue (issue #707 Decision §3). */
  color?: string;
  installed: boolean;
}

const ASSISTANT_TAB: Omit<BandTab, "installed"> = {
  icon: "Sparkle",
  id: ASSISTANT_ID,
  name: "Assistant",
};

/** Resolve pinned ids into ordered band tabs, dropping any id that no longer
 *  resolves to a live app (e.g. a pinned gateway app since uninstalled) —
 *  the pin list is the source of truth for INTENT, not for what renders. */
export function buildBandTabs(
  pinnedIds: readonly string[],
  items: readonly LauncherItem[]
): BandTab[] {
  const byId = new Map(items.map((item) => [item.meta.id, item]));
  const tabs: BandTab[] = [];
  for (const id of sanitizePins(pinnedIds)) {
    if (id === ASSISTANT_ID) {
      tabs.push({ ...ASSISTANT_TAB, installed: true });
      continue;
    }
    const item = byId.get(id);
    if (!item) continue;
    tabs.push(entryFor(item));
  }
  return tabs;
}

function entryFor(item: LauncherItem): BandTab {
  return {
    color: item.meta.color,
    icon: item.meta.iconKey,
    id: item.meta.id,
    installed: item.installed,
    name: item.meta.name,
  };
}

/** Every pinnable entry — Assistant first, then the full catalog in its
 *  declared order — for the All-apps sheet's pin-management list. Unlike
 *  `buildBandTabs`, this is not filtered to what is currently pinned: the
 *  sheet needs to offer every candidate, pinned or not. */
export function buildAllEntries(items: readonly LauncherItem[]): BandTab[] {
  return [{ ...ASSISTANT_TAB, installed: true }, ...items.map(entryFor)];
}
