// The arithmetic behind Photos' three Places surfaces — shelf, detail and map.
// One module, so a card, the detail it opens and a pin name a place alike.
//
// `placeCards` and `placePoints` GROUP DIFFERENTLY ON PURPOSE: the shelf keys by
// coordinates rounded to one decimal (a card is a durable destination, and a key
// that moved with the drawing would break on resize), the map by pixel distance
// (`projectPlaces`) — collision is a question asked in the drawing's units.

import type {
  MapPin,
  PlacePoint,
} from "@centraid/blueprints/apps/photos/place-map";
import { readableName } from "@centraid/blueprints/apps/photos/place-map";
import {
  PLACE_NO_LOCATION,
  PLACE_UNNAMED,
  photosPinLabel,
} from "@centraid/blueprints/apps/photos/shared-copy";

import type { PhotoAsset } from "./timeline-model";

/** A `core.place` row as the replica hands it over: RAW column names. */
export type PlaceRow = Record<string, unknown>;

export interface PlaceCard {
  /** A `placeCardKey`, or `NO_LOCATION_KEY`. */
  id: string;
  name: string;
  count: number;
  coverUri?: string;
}

/** The row the NEWEST photograph at `placeKey` points at — the same row
 *  `placeCards` titles from, so the two cannot name different neighbours inside
 *  one 0.1° cell. */
function newestRowAt(
  assets: readonly PhotoAsset[],
  rows: readonly PlaceRow[],
  placeKey: string
): PlaceRow | null {
  const placeById = placeRowsById(rows);
  for (const asset of assets) {
    if (asset.deleted || !asset.placeId) continue;
    const row = placeById.get(asset.placeId);
    if (row && placeCardKey(row) === placeKey) return row;
  }
  return null;
}

/** The name to PRINT for `placeKey`, or null when there is none a person would
 *  recognise (#816). Callers read this at render, never a route parameter, or a
 *  screen opened before the place was named keeps the fallback. A
 *  coordinate-shaped label is not a name — hence not `row.name`. */
export function placeNameAt(
  assets: readonly PhotoAsset[],
  rows: readonly PlaceRow[],
  placeKey: string
): string | null {
  const row = newestRowAt(assets, rows, placeKey);
  return row ? readableName(row.name ? String(row.name) : null) : null;
}

/** The row to ask a name for, or null when there is nothing to ask (#816): a
 *  member who named somewhere is never asked again. The coordinate-shaped
 *  placeholder `findOrCreatePlaceTx` mints is not such a name. */
export function unnamedPlaceAt(
  assets: readonly PhotoAsset[],
  rows: readonly PlaceRow[],
  placeKey: string
): string | null {
  const row = newestRowAt(assets, rows, placeKey);
  if (!row) return null;
  return readableName(row.name ? String(row.name) : null) === null
    ? String(row.place_id)
    : null;
}

/** The web map's ramp: AREA tracks the count, and the floor is a fingertip. */
export const PIN_MIN = 44;
export const PIN_MAX = 76;

function placeRowsById(rows: readonly PlaceRow[]): Map<string, PlaceRow> {
  return new Map(rows.map((row) => [String(row.place_id), row]));
}

/** A coordinate is a NUMBER column or it is nothing: dropped by type, never
 *  coerced and caught as `NaN` downstream (the guard `readPlaces` applies). */
function coordOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The shelf's key: coordinates rounded to one decimal, or null when the row has
 * none — a card standing at a coordinate nobody recorded claims geography.
 *
 * Column contract (#787): `core_place` ships `geo_lat`/`geo_lng` and mobile
 * gets rows RAW, so the physical columns come first; `latitude`/`lat` are
 * legacy fixture fallbacks only. `placePoints` reads the same chain.
 */
export function placeCardKey(row: PlaceRow | undefined): string | null {
  if (!row) return null;
  const latitude = coordOf(row.geo_lat ?? row.latitude ?? row.lat);
  const longitude = coordOf(row.geo_lng ?? row.longitude ?? row.lng);
  if (latitude === null || longitude === null) return null;
  return `${latitude.toFixed(1)}:${longitude.toFixed(1)}`;
}

/** The shelf's cards, largest first. Only photographs that carry a place: one
 *  with none is not "somewhere unknown" (see `noLocationCard`). */
export function placeCards(
  assets: readonly PhotoAsset[],
  rows: readonly PlaceRow[]
): PlaceCard[] {
  const placeById = placeRowsById(rows);
  const groups = new Map<
    string,
    { name: string; count: number; coverUri?: string }
  >();
  for (const asset of assets) {
    if (!asset.placeId) continue;
    const row = placeById.get(asset.placeId);
    const key = placeCardKey(row);
    if (!row || key === null) continue;
    // `readableName` is the one predicate both surfaces ask; without it the
    // card prints `findOrCreatePlaceTx`'s digits as if typed (#816).
    const name =
      readableName(row.name ? String(row.name) : null) ?? PLACE_UNNAMED;
    const current = groups.get(key);
    if (current) {
      current.count += 1;
      current.coverUri ??= asset.previewUri ?? asset.uri;
    } else {
      groups.set(key, {
        name,
        count: 1,
        coverUri: asset.previewUri ?? asset.uri,
      });
    }
  }
  return [...groups.entries()]
    .map(([id, group]) => ({ id, ...group }))
    .sort((a, b) => b.count - a.count);
}

/** Reserved shelf key (#816), spelled as the web shelf spells it so a hit and
 *  its destination agree. It cannot collide with a `placeCardKey`. */
export const NO_LOCATION_KEY = "no-location";

/** A different sentence from `PLACE_UNNAMED`: nobody told this photograph where
 *  it was taken, as against a located place with no label. */
export const NO_LOCATION_NAME = PLACE_NO_LOCATION;

/** Strictly "no place id", NOT "no card on the shelf" — a place carrying no
 *  coordinate is unplottable, not unlocated. Trash is excluded, as in
 *  `assetsAtPlace`. */
export function assetsWithNoPlace(assets: readonly PhotoAsset[]): PhotoAsset[] {
  return assets.filter((asset) => !asset.deleted && !asset.placeId);
}

/** Kept out of `placeCards` on purpose: that answers "which places are in this
 *  library", and this bucket is not a place (#816). */
export function noLocationCard(
  assets: readonly PhotoAsset[]
): PlaceCard | null {
  const placeless = assetsWithNoPlace(assets);
  if (placeless.length === 0) return null;
  const cover = placeless.find((asset) => asset.previewUri ?? asset.uri);
  return {
    id: NO_LOCATION_KEY,
    name: NO_LOCATION_NAME,
    count: placeless.length,
    // Assets arrive newest first, so this is the most recent, not an arbitrary.
    ...(cover ? { coverUri: cover.previewUri ?? cover.uri } : {}),
  };
}

/** Over the same key `placeCards` mints, minus trash, so a card's count and its
 *  detail's cannot disagree. `NO_LOCATION_KEY` resolves here, never in
 *  `PlaceDetail` (#816): one arithmetic, written once. */
export function assetsAtPlace(
  assets: readonly PhotoAsset[],
  rows: readonly PlaceRow[],
  placeKey: string
): PhotoAsset[] {
  if (placeKey === NO_LOCATION_KEY) return assetsWithNoPlace(assets);
  const placeById = placeRowsById(rows);
  return assets.filter((asset) => {
    if (asset.deleted || !asset.placeId) return false;
    return placeCardKey(placeById.get(asset.placeId)) === placeKey;
  });
}

/** Grouped by place id, NEVER by rounded coordinates: `projectPlaces` answers
 *  proximity in pixels against the box being drawn, and a fixed degree bucket
 *  merges two towns on a country map while splitting one street on a city one. */
export function placePoints(
  assets: readonly PhotoAsset[],
  rows: readonly PlaceRow[]
): PlacePoint[] {
  const placeById = placeRowsById(rows);
  const byPlace = new Map<string, PlacePoint>();
  for (const asset of assets) {
    const row = asset.placeId ? placeById.get(asset.placeId) : undefined;
    if (!row) continue;
    const lat = coordOf(row.geo_lat ?? row.latitude ?? row.lat);
    const lng = coordOf(row.geo_lng ?? row.longitude ?? row.lng);
    if (lat === null || lng === null) continue;
    const key = String(row.place_id);
    const existing = byPlace.get(key);
    if (existing) existing.count += 1;
    else
      byPlace.set(key, {
        key,
        lat,
        lng,
        count: 1,
        name: row.name ? String(row.name) : null,
        // First seen, and assets arrive newest first — so, the most recent.
        thumb: asset.uri,
      });
  }
  return [...byPlace.values()];
}

export function pinSize(count: number, largest: number): number {
  if (largest <= 1) return PIN_MIN;
  return Math.round(
    PIN_MIN + (PIN_MAX - PIN_MIN) * (Math.sqrt(count) / Math.sqrt(largest))
  );
}

/** A place still named by its own coordinate has no name worth reading out. */
export function pinLabel(pin: MapPin): string {
  const where = readableName(pin.name) ?? "an unnamed place";
  const photographs = `${pin.count} ${pin.count === 1 ? "photograph" : "photographs"}`;
  return photosPinLabel(where, pin.places, photographs);
}
