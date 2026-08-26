// NO CAP on Home grid pins — a grid scrolls; and unpinned is never hidden, a
// pin only lifts an app to the front. No app is pinned by default: the catalog
// order is the only opinion the grid carries.

import { useSyncExternalStore } from "react";

import { Store } from "../../storage";
import { DEFAULT_PLACE_PINS } from "./places";
import type { PlaceId } from "./places";

const KEY = "settings.homePins";

const NO_PINS: readonly string[] = [];

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** De-duplicate only: an unresolvable id is dropped where the grid is BUILT
 *  (./catalog#orderByPins), so an unlistable app keeps its pin. */
export function sanitizePins(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

export function getPins(): string[] {
  return Store.get<string[]>(KEY, NO_PINS as string[]);
}

export async function hydratePins(): Promise<string[]> {
  const raw = await Store.hydrate<string[]>(KEY, NO_PINS as string[]);
  const clean = sanitizePins(raw);
  if (clean.length !== raw.length) Store.set(KEY, clean);
  return clean;
}

export function setPins(ids: readonly string[]): void {
  Store.set(KEY, sanitizePins(ids));
  emit();
}

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

const PLACE_KEY = "settings.placePins";

const placeListeners = new Set<() => void>();

function emitPlaces(): void {
  for (const listener of placeListeners) listener();
}

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
