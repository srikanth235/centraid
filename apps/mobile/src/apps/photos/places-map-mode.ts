// WHICH MAP THE MEMBER IS LOOKING AT, as a member preference (#816).
//
// Places draws two maps off one projection. **Real maps** is the default: the
// phone's own basemap — MapKit on iOS, MapLibre over OpenFreeMap tiles on
// Android, both keyless — with our pins on top of it. **Private sketch** is
// the graticule the web shelf draws, computed here from coordinates the vault
// already holds and asking nothing of anybody.
//
// THE DEFAULT IS REAL, AND THAT IS A DECISION WITH A COST. A basemap is
// fetched by tile, and a tile URL is an area: the provider learns which
// neighbourhoods a member opened, at the resolution they opened them. It never
// learns anything else — no photograph, no place name, no phrase, and no
// coordinate the member did not already put on screen — because the pins are
// drawn by this app over a base layer that is handed nothing but a viewport.
// `MAP_EGRESS_NOTE` states that in the product, on the map, in both modes.
// It is a DISCLOSURE, not a gate: a member is told, not asked, and the switch
// beside it is the answer if they would rather not (docs/decisions.md, P-egress).
//
// It persists PER DEVICE, exactly like the tile-size rung (`photos-rung-store.ts`)
// and `bandOwner` before it: this repo has no server-side member-preference
// plane, and the honest place for "which map do I want" is the device the map
// is drawn on.

import { useCallback, useSyncExternalStore } from "react";

import type {
  MapPin,
  PlacePoint,
} from "@centraid/blueprints/apps/photos/place-map";

import { Store } from "../../storage";

/** The two maps. `real` is the phone's basemap; `sketch` is the projection. */
export type PlacesMapMode = "real" | "sketch";

/** Namespaced under `photos.` like every other Photos-scoped device key. */
export const PLACES_MAP_MODE_KEY = "photos.placesMapMode";

export const DEFAULT_PLACES_MAP_MODE: PlacesMapMode = "real";

/** The chip in the map's header, and the two answers behind it. Two words at
 *  most: a menu row's whole grammar is "this is the current answer". */
export const MAP_MODE_CHIP = "Map";
export const REAL_MAP_LABEL = "Real maps";
export const SKETCH_MAP_LABEL = "Private sketch";

/**
 * The egress disclosure, printed under the map in BOTH modes.
 *
 * One sentence, because the label carries the meaning and a disclosure that
 * needs a paragraph is one a member stops reading. Both halves are load
 * bearing: the first names exactly what the base layer learns, the second is
 * unconditional and true of the sketch as well, so a member never has to work
 * out which mode the promise applied to.
 */
export const MAP_EGRESS_NOTE =
  "The map provider sees which areas you open — no photograph, name or phrase ever leaves this device.";

/** The other mode's half of the same disclosure. Printed in the same slot, so
 *  the line a member reads always describes the map they are looking at. */
export const SKETCH_NOTE =
  "Nothing is fetched — this map is drawn here from your own coordinates.";

/** The note for the mode on screen. One slot, two truths, no mode a member has
 *  to work out for themselves. */
export function mapModeNote(mode: PlacesMapMode): string {
  return mode === "real" ? MAP_EGRESS_NOTE : SKETCH_NOTE;
}

/** OSM's licence terms require this on the map itself wherever OpenFreeMap's
 *  tiles are drawn, which is the Android basemap. */
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";

/**
 * THE CONTRACT BOTH MAPS SATISFY — the seam the mode switch swaps across.
 *
 * Places, a box, and one callback each way. Deliberately NOT a projection:
 * each surface runs `projectPlaces` itself, because the sketch's camera is
 * fitted to the points once while a basemap's camera is whatever the member's
 * fingers last left it at. What they share is the FUNCTION, so the two never
 * group differently at the same scale — see `place-map.ts`'s tier ladder.
 */
export interface PlacesMapSurfaceProps {
  points: readonly PlacePoint[];
  width: number;
  height: number;
  /** The place being read, drawn as the one ringed pin. */
  activeKey: string | null;
  /** A pin was pressed, or the ground was — which reads as nothing. */
  onRead: (pin: MapPin | null) => void;
}

/** A stored value that is not one of the two answers is not an answer. Anything
 *  else — a key written by an older build, a corrupted read — falls back to the
 *  default rather than leaving the map in a third state nothing renders. */
export function coerceMapMode(value: unknown): PlacesMapMode {
  return value === "sketch" || value === "real"
    ? value
    : DEFAULT_PLACES_MAP_MODE;
}

let current: PlacesMapMode = DEFAULT_PLACES_MAP_MODE;
let hydrated = false;
/** `setMapMode` already answered this process. An in-flight first hydrate
 *  must not put the disk (or the default) back over that choice. */
let chosen = false;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) listener();
}

/** Read the stored mode once per process, then keep it in memory. */
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

/** The mode, and the one way to change it. Every caller sees the same value. */
export function usePlacesMapMode(): [
  PlacesMapMode,
  (next: PlacesMapMode) => void,
] {
  hydrateMapMode();
  const mode = useSyncExternalStore(subscribe, getSnapshot);
  return [mode, useCallback((next: PlacesMapMode) => setMapMode(next), [])];
}
