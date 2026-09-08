// Places arithmetic. `placeCards` keys by 0.1° (durable); `placePoints` by
// pixel distance (`projectPlaces`) — grouping differs on purpose.

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

/** `core.place` row as the replica hands it over: RAW column names. */
export type PlaceRow = Record<string, unknown>;

export interface PlaceCard {
  id: string;
  name: string;
  count: number;
  coverUri?: string;
}

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

/** Printable name, or null (#816). Read at render — never a route parameter. */
export function placeNameAt(
  assets: readonly PhotoAsset[],
  rows: readonly PlaceRow[],
  placeKey: string
): string | null {
  const row = newestRowAt(assets, rows, placeKey);
  return row ? readableName(row.name ? String(row.name) : null) : null;
}

/** Place id to ask a name for, or null (#816). Coordinate placeholders are not names. */
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

export const PIN_MIN = 44;
export const PIN_MAX = 76;

function placeRowsById(rows: readonly PlaceRow[]): Map<string, PlaceRow> {
  return new Map(rows.map((row) => [String(row.place_id), row]));
}

/** Number column or nothing — never coerce (the `readPlaces` NaN guard). */
function coordOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Shelf key: 0.1° rounded, or null. Column contract (#787): `geo_lat`/`geo_lng`
 * first; `latitude`/`lat` are fixture fallbacks. `placePoints` reads the same chain.
 */
export function placeCardKey(row: PlaceRow | undefined): string | null {
  if (!row) return null;
  const latitude = coordOf(row.geo_lat ?? row.latitude ?? row.lat);
  const longitude = coordOf(row.geo_lng ?? row.longitude ?? row.lng);
  if (latitude === null || longitude === null) return null;
  return `${latitude.toFixed(1)}:${longitude.toFixed(1)}`;
}

export interface PlaceCell {
  key: string;
  name: string;
  placeIds: readonly string[];
}

export function placeCells(rows: readonly PlaceRow[]): PlaceCell[] {
  const cells = new Map<string, { name: string; placeIds: string[] }>();
  for (const row of rows) {
    const key = placeCardKey(row);
    if (key === null) continue;
    const name = readableName(row.name ? String(row.name) : null);
    const current = cells.get(key);
    if (current) {
      current.placeIds.push(String(row.place_id));
      if (current.name === PLACE_UNNAMED && name) current.name = name;
    } else {
      cells.set(key, {
        name: name ?? PLACE_UNNAMED,
        placeIds: [String(row.place_id)],
      });
    }
  }
  return [...cells.entries()].map(([key, cell]) => ({ key, ...cell }));
}

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
    // Both surfaces use `readableName`; else digits print as a typed name (#816).
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

/** Reserved shelf key (#816). Cannot collide with a `placeCardKey`. */
export const NO_LOCATION_KEY = "no-location";

/** Unlocated photo — not a located place with no label (`PLACE_UNNAMED`). */
export const NO_LOCATION_NAME = PLACE_NO_LOCATION;

/** No place id — not "no card". Unplottable ≠ unlocated. Trash excluded. */
export function assetsWithNoPlace(assets: readonly PhotoAsset[]): PhotoAsset[] {
  return assets.filter((asset) => !asset.deleted && !asset.placeId);
}

/** Not a place — kept out of `placeCards` on purpose (#816). */
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
    ...(cover ? { coverUri: cover.previewUri ?? cover.uri } : {}),
  };
}

/** Same key as `placeCards`, minus trash. `NO_LOCATION_KEY` resolves here (#816). */
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

/** Group by place id, never by rounded coordinates (`projectPlaces` uses pixels). */
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

export function pinLabel(pin: MapPin): string {
  const where = readableName(pin.name) ?? "an unnamed place";
  const photographs = `${pin.count} ${pin.count === 1 ? "photograph" : "photographs"}`;
  return photosPinLabel(where, pin.places, photographs);
}
