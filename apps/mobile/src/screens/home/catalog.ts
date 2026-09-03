import { apps as BUILTIN_APPS } from "@centraid/design";
import type { AppMetaResolved } from "@centraid/design";

import { SPRINGBOARD_ORDER } from "./springboard-policy";

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
  meta: AppMetaResolved;
  route: LauncherRoute;
}

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

export function buildLauncherItems(): LauncherItem[] {
  return NATIVE_APPS.flatMap((meta) => {
    const route = NATIVE_ROUTES[meta.id];
    return route ? [{ meta, route }] : [];
  });
}

export function orderForSpringboard(
  items: readonly LauncherItem[]
): LauncherItem[] {
  const rank = (item: LauncherItem): number => {
    const at = SPRINGBOARD_ORDER.indexOf(item.meta.id);
    return at < 0 ? SPRINGBOARD_ORDER.length : at;
  };
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
