// WHICH MAP THE MEMBER IS LOOKING AT (#816). `real` is the default: basemap
// tiles tell the provider which areas were opened and nothing else, which
// `MAP_EGRESS_NOTE` discloses rather than gates (P-egress).

import { useCallback, useSyncExternalStore } from "react";

import type {
  MapPin,
  PlacePoint,
} from "@centraid/blueprints/apps/photos/place-map";

import { Store } from "../../storage";

export type PlacesMapMode = "real" | "sketch";

export const PLACES_MAP_MODE_KEY = "photos.placesMapMode";

export const DEFAULT_PLACES_MAP_MODE: PlacesMapMode = "real";

export const MAP_MODE_CHIP = "Map";
export const REAL_MAP_LABEL = "Real maps";
export const SKETCH_MAP_LABEL = "Private sketch";

export const MAP_EGRESS_NOTE =
  "The map provider sees which areas you open — no photograph, name or phrase ever leaves this device.";

export const SKETCH_NOTE =
  "Nothing is fetched — this map is drawn here from your own coordinates.";

export function mapModeNote(mode: PlacesMapMode): string {
  return mode === "real" ? MAP_EGRESS_NOTE : SKETCH_NOTE;
}

/** Required by OSM's licence wherever OpenFreeMap tiles are drawn. */
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";

/** No projection here: each surface runs `projectPlaces` itself. */
export interface PlacesMapSurfaceProps {
  points: readonly PlacePoint[];
  width: number;
  height: number;
  activeKey: string | null;
  onRead: (pin: MapPin | null) => void;
}

export function coerceMapMode(value: unknown): PlacesMapMode {
  return value === "sketch" || value === "real"
    ? value
    : DEFAULT_PLACES_MAP_MODE;
}

let current: PlacesMapMode = DEFAULT_PLACES_MAP_MODE;
let hydrated = false;
let chosen = false;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) listener();
}

export function hydrateMapMode(): void {
  if (hydrated) return;
  hydrated = true;
  void Store.hydrate<unknown>(
    PLACES_MAP_MODE_KEY,
    DEFAULT_PLACES_MAP_MODE
  ).then((stored) => {
    if (chosen) return;
    const next = coerceMapMode(stored);
    if (next === current) return;
    current = next;
    publish();
  });
}

export function setMapMode(next: PlacesMapMode): void {
  chosen = true;
  if (next === current) return;
  current = next;
  Store.set(PLACES_MAP_MODE_KEY, next);
  publish();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getSnapshot = (): PlacesMapMode => current;

export function usePlacesMapMode(): [
  PlacesMapMode,
  (next: PlacesMapMode) => void,
] {
  hydrateMapMode();
  const mode = useSyncExternalStore(subscribe, getSnapshot);
  return [mode, useCallback((next: PlacesMapMode) => setMapMode(next), [])];
}
