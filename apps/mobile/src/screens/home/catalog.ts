// The Home launcher catalog + merge logic (issue #498, Slice B change #4).
//
// The springboard now shows all eight first-party apps *always*, whether or not
// a desktop is paired: the three native covers (Photos / Docs / Agenda) plus the
// five native domain covers (Tasks / Notes / People / Locker / Tally). All
// eight ship in the binary and read the encrypted replica, while user-created
// apps still open through the gateway-hosted compatibility cover.
//
// This module is pure (no React / navigation imports) so the merge rule stays
// unit-testable and the routing decision lives in exactly one place.

import { apps as BUILTIN_APPS } from "@centraid/design";
import type { AppMetaResolved } from "@centraid/design";

import { SPRINGBOARD_ORDER } from "./springboard-policy";

// Where a launcher tile goes when tapped. The three native kinds map onto the
// nested cover navigators; `app` opens a remote app's WebView cover; `pair`
// diverts an uninstalled gateway app to Settings (pairing) instead.
export type LauncherRoute =
  | { kind: "photos" }
  | { kind: "docs" }
  | { kind: "agenda" }
  | { kind: "locker" }
  | { kind: "tasks" }
  | { kind: "people" }
  | { kind: "notes" }
  | { kind: "tally" }
  | { kind: "app"; appId: string }
  | { kind: "pair" };

export interface LauncherItem {
  /** Tile display metadata (emblem glyph, name). */
  meta: AppMetaResolved;
  /** Where tapping the tile navigates. */
  route: LauncherRoute;
  /** `false` renders the dimmed "on your desktop" placeholder. */
  installed: boolean;
}

// The native covers are always installed — their UI is in the binary — so
// they never dim. This is the product catalog, not a second mobile catalog:
// app name, icon, colour, and description resolve through one source of truth.
const NATIVE_APPS: readonly AppMetaResolved[] = BUILTIN_APPS;

/** Native app ids — Home uses this to drop native rows out of the live listing. */
export const NATIVE_APP_IDS: ReadonlySet<string> = new Set(
  NATIVE_APPS.map((a) => a.id)
);

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

// Every bundled blueprint now has a native cover. User-created apps discovered
// from the gateway are appended below and keep the AppDetail compatibility path.
const GATEWAY_CATALOG: readonly AppMetaResolved[] = [];

/**
 * Compose the grid: native three, then the five catalog apps merged over the
 * live listing by id, then any extra apps the user has built that aren't in the
 * static catalog.
 *
 * - A catalog app present in `remoteApps` → normal tile, opens over AppDetail
 *   (and we prefer the live metadata so a custom name/icon from the manifest
 *   wins over the catalog default).
 * - A catalog app absent from `remoteApps` (not installed, or no gateway) →
 *   dimmed placeholder that routes to pairing.
 * - A live app not in the catalog → normal tile (the user built it themselves).
 *
 * `remoteApps` must already exclude the native ids (Home filters them out).
 */
export function buildLauncherItems(
  remoteApps: readonly AppMetaResolved[]
): LauncherItem[] {
  const liveById = new Map(remoteApps.map((app) => [app.id, app]));

  const items: LauncherItem[] = NATIVE_APPS.map((meta) => ({
    installed: true,
    meta,
    route: NATIVE_ROUTES[meta.id] ?? { kind: "app", appId: meta.id },
  }));

  const catalogIds = new Set<string>();
  for (const meta of GATEWAY_CATALOG) {
    catalogIds.add(meta.id);
    const live = liveById.get(meta.id);
    items.push(
      live
        ? {
            installed: true,
            meta: live,
            route: { kind: "app", appId: live.id },
          }
        : { installed: false, meta, route: { kind: "pair" } }
    );
  }

  for (const app of remoteApps) {
    if (catalogIds.has(app.id) || NATIVE_APP_IDS.has(app.id)) continue;
    items.push({
      installed: true,
      meta: app,
      route: { kind: "app", appId: app.id },
    });
  }

  return items;
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
/**
 * Put the grid into springboard order (./tile-model#SPRINGBOARD_ORDER) before
 * pins are applied.
 *
 * An app the order does not name — one the member built themselves — keeps its
 * catalog position BEHIND the eight first-party tiles rather than being dropped
 * or sorted to the front: the order is a statement about the shipped tiles, and
 * it has no opinion about an app it has never seen.
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
