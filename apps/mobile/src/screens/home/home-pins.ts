// The member's Home grid order (the Binding Layer, Tier 2: All apps).
//
// "Every app a 44px row with mark, recency, count and a pin switch. Pinning
// writes the home grid order." That is what this module persists: a list of app
// ids, in the order the member put them, which the springboard sorts by before
// it grades tiles. It replaces ./band-pins, which persisted the same shape for
// a band that no longer carries apps at all.
//
// Two differences from the band list it replaces, and both follow from the move
// off the band:
//
//  · NO CAP. Five was invariant 1's tab ceiling, not a statement about how many
//    apps a member may care about; a grid scrolls, so there is nothing to cap.
//  · Unpinned is not hidden. A pin lifts an app to the FRONT of the grid; every
//    other app keeps its catalog position behind the pinned ones. A launcher
//    that can hide an installed app is a launcher you can lose an app in.
//
// Storage lives here rather than in ./band so the pure list logic stays testable
// without mocking AsyncStorage — the same split the band/band-pins pair had.
//
// This file also owns the place pins (below), for the same reason: ./places
// and ./band stay pure plain-data modules, and the one AsyncStorage-backed
// module in this directory is where persistence for BOTH pin lists lives.

import { useSyncExternalStore } from "react";

import { Store } from "../../storage";
import { DEFAULT_PLACE_PINS } from "./places";
import type { PlaceId } from "./places";

const KEY = "settings.homePins";

/**
 * Out of the box: nothing is pinned.
 *
 * The grid's default order is the catalog's own, and the catalog order is a
 * design decision that already had reasons. A default pin list would be a
 * second, invisible opinion layered over it, and the member would have no way
 * to tell which one they were looking at.
 */
const NO_PINS: readonly string[] = [];

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** De-duplicate, preserving order. Nothing else: an id that no longer resolves
 *  to an app is dropped where the grid is BUILT (./catalog#orderByPins), not
 *  here, so an app that is temporarily unlistable does not lose its pin. */
export function sanitizePins(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

export function getPins(): string[] {
  return Store.get<string[]>(KEY, NO_PINS as string[]);
}

export async function hydratePins(): Promise<string[]> {
  const raw = await Store.hydrate<string[]>(KEY, NO_PINS as string[]);
  const clean = sanitizePins(raw);
  // Repair a duplicated stored list once, rather than carrying the mess
  // forward on every read.
  if (clean.length !== raw.length) Store.set(KEY, clean);
  return clean;
}

export function setPins(ids: readonly string[]): void {
  Store.set(KEY, sanitizePins(ids));
  emit();
}

/** Pin `id` to the front of the grid, or unpin it back to catalog order. */
export function togglePin(id: string, pinned: boolean): void {
  const current = getPins();
  if (pinned) {
    if (current.includes(id)) return;
    setPins([...current, id]);
  } else {
    setPins(current.filter((existing) => existing !== id));
  }
}

export function subscribePins(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePins(): string[] {
  return useSyncExternalStore(subscribePins, getPins, getPins);
}

// ── Place pins (the Binding Layer, v4 handoff) ──────────────────────────
//
// The same per-device toggle-list pattern as the app pins above, for the
// eleven stable place ids in ./places instead of the app catalog. Two
// differences from the app list: it stores `PlaceId`s, and it starts from the
// v10 `DEFAULT_PLACE_PINS` rather than empty — Alerts, Activity and Vault.
// More is standing, not conditional on overflow; a fourth member pin fills the
// last destination slot without displacing it.

const PLACE_KEY = "settings.placePins";

// A separate listener set from the app pins above: a place-pin toggle should
// not force every app-pin subscriber (the springboard grid) to re-check its
// own snapshot, and vice versa.
const placeListeners = new Set<() => void>();

function emitPlaces(): void {
  for (const listener of placeListeners) listener();
}

/** De-duplicate, preserving order — same rule as `sanitizePins`. An id that no
 *  longer names a place is left for ./places' table lookups to ignore, not
 *  dropped here, so a place that is temporarily unlistable keeps its pin. */
export function sanitizePlacePins(ids: readonly PlaceId[]): PlaceId[] {
  return [...new Set(ids)];
}

export function getPlacePins(): PlaceId[] {
  return Store.get<PlaceId[]>(PLACE_KEY, DEFAULT_PLACE_PINS as PlaceId[]);
}

export function setPlacePins(ids: readonly PlaceId[]): void {
  Store.set(PLACE_KEY, sanitizePlacePins(ids));
  emitPlaces();
}

/** Pin `id` to the launcher (band + All-apps), or unpin it. Home has no
 *  switch in the sheet at all (it is pinned by law), so this is never called
 *  with `"home"` — callers guard that at the UI layer, same as `togglePin`
 *  does not need to reject an app id that cannot resolve. */
export function togglePlacePin(id: PlaceId, pinned: boolean): void {
  const current = getPlacePins();
  if (pinned) {
    if (current.includes(id)) return;
    setPlacePins([...current, id]);
  } else {
    setPlacePins(current.filter((existing) => existing !== id));
  }
}

export function subscribePlacePins(listener: () => void): () => void {
  placeListeners.add(listener);
  return () => placeListeners.delete(listener);
}

export function usePlacePins(): PlaceId[] {
  return useSyncExternalStore(subscribePlacePins, getPlacePins, getPlacePins);
}
