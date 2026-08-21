// The drive's remembered view — list or grid, WITH its sort, as one value
// (handoff Part 2 §1: "Two views of one set — list and grid — with the choice
// and the sort remembered together").
//
// One storage key holding both is what "remembered together" means in code: a
// preference that could persist one half and lose the other would be two
// preferences. Persisted the way the frame persists the band owner
// (`kit/band/band-owner.ts`): the device Store, hydrated once per mount,
// written through on change. This repo has no server-side member-preference
// plane, so per-device is the honest scope.

import { useCallback, useEffect, useState } from "react";

import type { SortKey } from "@centraid/blueprints/apps/docs/types";

import { Store } from "../../storage";

export type DriveView = "list" | "grid";

export interface DriveViewPrefs {
  view: DriveView;
  sortKey: SortKey;
  sortDir: 1 | -1;
}

/** The handoff's default: list rows, date changed, newest first. */
export const DEFAULT_DRIVE_PREFS: DriveViewPrefs = {
  view: "list",
  sortKey: "changed",
  sortDir: -1,
};

export const DRIVE_PREFS_KEY = "docs.drive.viewSort";

const SORT_KEYS: readonly SortKey[] = [
  "changed",
  "kind",
  "name",
  "owner",
  "size",
];

/** Narrow a hydrated value — the store is JSON, so anything could be in it. */
export function asDrivePrefs(value: unknown): DriveViewPrefs {
  if (!value || typeof value !== "object") return DEFAULT_DRIVE_PREFS;
  const raw = value as Partial<DriveViewPrefs>;
  return {
    view: raw.view === "grid" ? "grid" : "list",
    sortKey: SORT_KEYS.includes(raw.sortKey as SortKey)
      ? (raw.sortKey as SortKey)
      : DEFAULT_DRIVE_PREFS.sortKey,
    sortDir: raw.sortDir === 1 ? 1 : -1,
  };
}

export function useDriveViewPrefs(): [
  DriveViewPrefs,
  (next: Partial<DriveViewPrefs>) => void,
] {
  const [prefs, setPrefs] = useState<DriveViewPrefs>(DEFAULT_DRIVE_PREFS);
  useEffect(() => {
    let live = true;
    void Store.hydrate(DRIVE_PREFS_KEY, DEFAULT_DRIVE_PREFS).then((stored) => {
      if (live) setPrefs(asDrivePrefs(stored));
    });
    return () => {
      live = false;
    };
  }, []);
  const update = useCallback((next: Partial<DriveViewPrefs>) => {
    setPrefs((current) => {
      const merged = { ...current, ...next };
      Store.set(DRIVE_PREFS_KEY, merged);
      return merged;
    });
  }, []);
  return [prefs, update];
}
