// The arithmetic behind Photos' three Places surfaces on the phone — the
// shelf of cards (`PlacesView`), one place's photographs (`PlaceDetail`), and
// the map (`PlacesMap`) — with no React, no theme, and no renderer in it.
//
// It is one module rather than three private helpers because the three
// screens make ONE claim between them: a card, the detail it opens, and a pin
// must name the same place the same way. That claim is only checkable if the
// naming is written once; while each screen kept its own copy, "they agree"
// was a comment rather than a fact, and nothing would have noticed the day one
// of the three drifted.
//
// The split inside is deliberate and is NOT an accident of the extraction:
//
//  - the SHELF (cards, detail) names a place by its coordinates rounded to one
//    decimal — roughly 11km — because a card is a durable destination a member
//    navigates to, and a key that moved with the drawing would break the
//    moment the map was resized;
//  - the MAP merges by pixel distance instead (`projectPlaces` in
//    `@centraid/blueprints/apps/photos/place-map`), because whether two pins
//    collide is a question about the drawing and is therefore asked in the
//    drawing's units.
//
// So `placeCards` and `placePoints` group differently on purpose. What they
// share is which rows are plottable at all, and the ramp/label a pin carries.

import type {
  MapPin,
  PlacePoint,
} from "@centraid/blueprints/apps/photos/place-map";
import { readableName } from "@centraid/blueprints/apps/photos/place-map";
import {
  PLACE_UNNAMED,
  photosPinLabel,
} from "@centraid/blueprints/apps/photos/shared-copy";

import type { PhotoAsset } from "./timeline-model";

/** A `core.place` row as the replica hands it over: column names, raw values. */
export type PlaceRow = Record<string, unknown>;

/** One place's card on the shelf. */
export interface PlaceCard {
  /** The shelf's own place key — see `placeCardKey`. */
  id: string;
  name: string;
  count: number;
  coverUri?: string;
}

/** Matches the web map's pin ramp: AREA tracks the count, so nine photographs
 *  read as three times one rather than nine times it. The floor is a fingertip
 *  and also the smallest a photograph can be and still be recognised — which
 *  is the entire point of drawing one. */
export const PIN_MIN = 44;
export const PIN_MAX = 76;

function placeRowsById(rows: readonly PlaceRow[]): Map<string, PlaceRow> {
  return new Map(rows.map((row) => [String(row.place_id), row]));
}

/**
 * A coordinate is a NUMBER column or it is nothing — the same guard the web
 * handler applies when it renames the columns (`readPlaces` in
 * `queries/_shared.ts`): an explicit `NULL` from the vault, a string, or any
 * other type is dropped by type, never coerced and caught as `NaN` downstream.
 */
function coordOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The key the SHELF names a place by: its coordinates rounded to one decimal.
 *
 * `null` when the row carries no usable coordinates — such a place has no card
 * and no pin, because a card standing at a coordinate nobody recorded would be
 * a claim about geography rather than a read of one.
 *
 * Column contract (#787): `core_place` ships `geo_lat`/`geo_lng`
 * (packages/vault/src/schema/core.ts) and the mobile timeline hands rows RAW —
 * only the web handler renames them (queries/_shared.ts). So the physical
 * columns are read first, with `latitude`/`lat` (and `longitude`/`lng`) kept
 * only as legacy fixture fallbacks, the same chain `placePoints` reads.
 */
export function placeCardKey(row: PlaceRow | undefined): string | null {
  if (!row) return null;
  const latitude = coordOf(row.geo_lat ?? row.latitude ?? row.lat);
  const longitude = coordOf(row.geo_lng ?? row.longitude ?? row.lng);
  if (latitude === null || longitude === null) return null;
  return `${latitude.toFixed(1)}:${longitude.toFixed(1)}`;
}

/**
 * The shelf's cards, largest first.
 *
 * Only photographs that carry a place appear: a photograph with no place is
 * not "somewhere unknown", it is one nobody told where it was taken.
 */
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
    const name = row.name ? String(row.name) : PLACE_UNNAMED;
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

/**
 * The photographs one card opens: everything taken at that shelf key, minus
 * anything in the trash. Same key `placeCards` mints, so the count on a card
 * and the count in its detail cannot disagree.
 */
export function assetsAtPlace(
  assets: readonly PhotoAsset[],
  rows: readonly PlaceRow[],
  placeKey: string
): PhotoAsset[] {
  const placeById = placeRowsById(rows);
  return assets.filter((asset) => {
    if (asset.deleted || !asset.placeId) return false;
    return placeCardKey(placeById.get(asset.placeId)) === placeKey;
  });
}

/**
 * One `PlacePoint` per place row, counted over the loaded window — what the
 * map projects.
 *
 * Grouping is by place id, not by rounded coordinates: proximity is a question
 * about the drawing and `projectPlaces` answers it in pixels against the box
 * actually being drawn. A fixed degree bucket merged two towns on a
 * country-wide map and split one street on a city one.
 */
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
        // The first asset seen for this place, and the timeline hands them
        // over newest first — so a pin shows the most recent photograph
        // taken there rather than an arbitrary one.
        thumb: asset.uri,
      });
  }
  return [...byPlace.values()];
}

/** The drawn size of a pin holding `count` photographs, where the busiest pin
 *  on the map holds `largest`. */
export function pinSize(count: number, largest: number): number {
  if (largest <= 1) return PIN_MIN;
  return Math.round(
    PIN_MIN + (PIN_MAX - PIN_MIN) * (Math.sqrt(count) / Math.sqrt(largest))
  );
}

/** What a pin announces: where it is, how many places merged into it, and how
 *  many photographs stand behind it. A place whose name is still its own
 *  coordinate has no name worth reading out (see `readableName`). */
export function pinLabel(pin: MapPin): string {
  const where = readableName(pin.name) ?? "an unnamed place";
  const photographs = `${pin.count} ${pin.count === 1 ? "photograph" : "photographs"}`;
  return photosPinLabel(where, pin.places, photographs);
}
