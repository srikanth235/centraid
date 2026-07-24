// The Home launcher catalog + merge logic (issue #498, Slice B change #4).
//
// The springboard now shows all eight first-party apps *always*, whether or not
// a desktop is paired: the three native covers (Photos / Docs / Agenda) plus the
// five gateway-hosted apps (Tasks / Notes / People / Locker / Tally). The native
// three ship in the binary; the gateway five only *open* once the app they front
// has been installed on the paired desktop. When they haven't, the tile still
// renders — dimmed, "on your desktop" — so the phone advertises the full surface
// and routes an early tap to pairing rather than hiding the app entirely.
//
// This module is pure (no React / navigation imports) so the merge rule stays
// unit-testable and the routing decision lives in exactly one place.

import type { AppMetaResolved } from '@centraid/design-tokens';
import { resolveAppMeta } from '../../lib/gateway';

// Where a launcher tile goes when tapped. The three native kinds map onto the
// nested cover navigators; `app` opens a remote app's WebView cover; `pair`
// diverts an uninstalled gateway app to Settings (pairing) instead.
export type LauncherRoute =
  | { kind: 'photos' }
  | { kind: 'docs' }
  | { kind: 'agenda' }
  | { kind: 'app'; appId: string }
  | { kind: 'pair' };

export interface LauncherItem {
  /** Tile display metadata (emblem glyph, name). */
  meta: AppMetaResolved;
  /** Where tapping the tile navigates. */
  route: LauncherRoute;
  /** `false` renders the dimmed "on your desktop" placeholder. */
  installed: boolean;
}

// The three native covers. These are always installed — their UI is in the
// binary — so they never dim. Colours here only tint `resolveAppMeta`'s derived
// metadata; the engraved AppIcon is monochrome, so the glyph is what reads.
const NATIVE_APPS: readonly AppMetaResolved[] = [
  resolveAppMeta({
    id: 'photos',
    name: 'Photos',
    description: 'Timeline, memories, albums and private backup.',
    iconKey: 'Camera',
    colorKey: 'ochre',
  }),
  resolveAppMeta({
    id: 'docs',
    name: 'Docs',
    description: 'Files, folders, offline search and secure custody.',
    iconKey: 'Folder',
    colorKey: 'slate',
  }),
  resolveAppMeta({
    id: 'agenda',
    name: 'Agenda',
    description: 'Calendar, schedule, guests and reminders.',
    iconKey: 'Calendar',
    colorKey: 'indigo',
  }),
];

/** Native app ids — Home uses this to drop native rows out of the live listing. */
export const NATIVE_APP_IDS: ReadonlySet<string> = new Set(NATIVE_APPS.map((a) => a.id));

const NATIVE_ROUTES: Record<string, LauncherRoute> = {
  photos: { kind: 'photos' },
  docs: { kind: 'docs' },
  agenda: { kind: 'agenda' },
};

// The five gateway apps the launcher always advertises. Glyphs are picked from
// @centraid/design-tokens `icons` — the closest silhouette where an exact match
// doesn't exist: Tasks→Todo (checklist), Notes→Journal, People→Users,
// Locker→Key (its vault), Tally→Coin (its ledger). Colours are just distinct
// hues for the derived metadata; the engraved emblem stays monochrome. These
// ids match the desktop blueprint app ids, so once installed the live listing
// merges over this entry by id (see buildLauncherItems).
const GATEWAY_CATALOG: readonly AppMetaResolved[] = [
  resolveAppMeta({
    id: 'tasks',
    name: 'Tasks',
    description: 'Lists, projects and what needs doing.',
    iconKey: 'Todo',
    colorKey: 'forest',
  }),
  resolveAppMeta({
    id: 'notes',
    name: 'Notes',
    description: 'Quick capture and long-form writing.',
    iconKey: 'Journal',
    colorKey: 'amber',
  }),
  resolveAppMeta({
    id: 'people',
    name: 'People',
    description: 'Your personal CRM — contacts and circles.',
    iconKey: 'Users',
    colorKey: 'rose',
  }),
  resolveAppMeta({
    id: 'locker',
    name: 'Locker',
    description: 'Passwords, codes and secrets under custody.',
    iconKey: 'Key',
    colorKey: 'slate',
  }),
  resolveAppMeta({
    id: 'tally',
    name: 'Tally',
    description: 'Money in, money out — a simple ledger.',
    iconKey: 'Coin',
    colorKey: 'violet',
  }),
];

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
export function buildLauncherItems(remoteApps: readonly AppMetaResolved[]): LauncherItem[] {
  const liveById = new Map(remoteApps.map((app) => [app.id, app]));

  const items: LauncherItem[] = NATIVE_APPS.map((meta) => ({
    installed: true,
    meta,
    route: NATIVE_ROUTES[meta.id] ?? { kind: 'app', appId: meta.id },
  }));

  const catalogIds = new Set<string>();
  for (const meta of GATEWAY_CATALOG) {
    catalogIds.add(meta.id);
    const live = liveById.get(meta.id);
    items.push(
      live
        ? { installed: true, meta: live, route: { kind: 'app', appId: live.id } }
        : { installed: false, meta, route: { kind: 'pair' } },
    );
  }

  for (const app of remoteApps) {
    if (catalogIds.has(app.id)) continue;
    items.push({ installed: true, meta: app, route: { kind: 'app', appId: app.id } });
  }

  return items;
}

/** Case-insensitive name/description filter for the search overlay. */
export function filterLauncherItems(items: readonly LauncherItem[], query: string): LauncherItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter(
    (it) => it.meta.name.toLowerCase().includes(q) || it.meta.desc.toLowerCase().includes(q),
  );
}
