// The Home launcher catalog + merge logic (issue #498, Slice B change #4).
//
// The springboard shows all eight first-party apps always, whether or not a
// desktop is paired: the three native covers (Photos / Docs / Agenda) plus the
// five native domain covers (Tasks / Notes / People / Locker / Tally). All
// eight ship in the binary and read the encrypted replica, so the grid fills
// offline and there is no gateway-hosted app to merge in (issue #799 retired
// the WebView cover, and with it the served-app plane on the phone).
//
// This module is pure (no React / navigation imports) so the merge rule stays
// unit-testable and the routing decision lives in exactly one place.

import { apps as BUILTIN_APPS } from "@centraid/design";
import type { AppMetaResolved } from "@centraid/design";

import { SPRINGBOARD_ORDER } from "./springboard-policy";

/** Where a launcher tile goes when tapped — one native cover per app. */
export type LauncherRoute =
  | { kind: "photos" }
  | { kind: "docs" }
  | { kind: "agenda" }
  | { kind: "locker" }
  | { kind: "tasks" }
  | { kind: "people" }
  | { kind: "notes" }
  | { kind: "tally" };

export interface LauncherItem {
  /** Tile display metadata (emblem glyph, name). */
  meta: AppMetaResolved;
  /** Where tapping the tile navigates. */
  route: LauncherRoute;
}

// This is the product catalog, not a second mobile catalog: app name, icon,
// colour, and description resolve through one source of truth.
const NATIVE_APPS: readonly AppMetaResolved[] = BUILTIN_APPS;

const NATIVE_ROUTES: Record<string, LauncherRoute> = {
  photos: { kind: "photos" },
  docs: { kind: "docs" },
  agenda: { kind: "agenda" },
  locker: { kind: "locker" },
  tasks: { kind: "tasks" },
  people: { kind: "people" },
  notes: { kind: "notes" },
  tally: { kind: "tally" },
};

/**
 * Compose the grid: the eight first-party apps, each on its native cover.
 *
 * An id `NATIVE_ROUTES` does not name would have nowhere to go, so it is left
 * out rather than routed at a guess — the two lists are the same eight ids and
 * `catalog.test.ts` pins that they stay so.
 */
export function buildLauncherItems(): LauncherItem[] {
  return NATIVE_APPS.flatMap((meta) => {
    const route = NATIVE_ROUTES[meta.id];
    return route ? [{ meta, route }] : [];
  });
}

/**
 * Put the grid into springboard order (./tile-model#SPRINGBOARD_ORDER) before
 * pins are applied.
 *
 * An app the order does not name keeps its catalog position BEHIND the tiles it
 * does rather than being dropped or sorted to the front: the order is a
 * statement about the shipped tiles, and it has no opinion about anything else.
 */
export function orderForSpringboard(
  items: readonly LauncherItem[]
): LauncherItem[] {
  const rank = (item: LauncherItem): number => {
    const at = SPRINGBOARD_ORDER.indexOf(item.meta.id);
    return at < 0 ? SPRINGBOARD_ORDER.length : at;
  };
  // Index-tiebroken so the sort is stable across engines: two unranked apps
  // keep their catalog order, and the same vault produces the same page on
  // every launch.
  return items
    .map((item, at) => ({ at, item }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.at - b.at)
    .map((entry) => entry.item);
}

/**
 * Apply the member's pin order to the grid (Tier 2: "pinning writes the home
 * grid order").
 *
 * Pinned apps come first, in the order they were pinned; everything else keeps
 * its catalog position behind them. An unpinned app is never HIDDEN — a
 * launcher you can lose an app in is not a launcher — and a pinned id that no
 * longer resolves to a listed app is simply skipped rather than repaired, so an
 * app that is temporarily unlistable keeps its pin for when it comes back.
 */
export function orderByPins(
  items: readonly LauncherItem[],
  pinnedIds: readonly string[]
): LauncherItem[] {
  const byId = new Map(items.map((item) => [item.meta.id, item]));
  const pinned: LauncherItem[] = [];
  const taken = new Set<string>();
  for (const id of pinnedIds) {
    const item = byId.get(id);
    if (!item || taken.has(id)) continue;
    taken.add(id);
    pinned.push(item);
  }
  return [...pinned, ...items.filter((item) => !taken.has(item.meta.id))];
}

/** Case-insensitive name/description filter for the search overlay. */
export function filterLauncherItems(
  items: readonly LauncherItem[],
  query: string
): LauncherItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter(
    (it) =>
      it.meta.name.toLowerCase().includes(q) ||
      it.meta.desc.toLowerCase().includes(q)
  );
}
