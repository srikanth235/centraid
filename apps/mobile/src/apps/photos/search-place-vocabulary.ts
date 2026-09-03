import { readableName } from "@centraid/blueprints/apps/photos/place-map";
import {
  distanceKm,
  gazetteerNameFrom,
  homeBand,
  placePhrase,
} from "@centraid/blueprints/apps/photos/place-phrase";
import type { NamedPlace } from "@centraid/blueprints/apps/photos/place-phrase";
import {
  PLACE_HOME_TERMS,
  PLACE_NO_LOCATION_TERMS,
} from "@centraid/blueprints/apps/photos/shared-copy";

import type { PlaceRow } from "./places-model";

export function rowText(
  row: Readonly<Record<string, unknown>>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (value != null && String(value).trim()) return String(value);
  }
  return undefined;
}

export function rowCoords(row: PlaceRow): { lat: number; lng: number } | null {
  const lat = row.geo_lat ?? row.latitude ?? row.lat;
  const lng = row.geo_lng ?? row.longitude ?? row.lng;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

export function namedPlaceAnchors(rows: readonly PlaceRow[]): NamedPlace[] {
  return rows.flatMap((row) => {
    const id = rowText(row, "place_id");
    const name = readableName(rowText(row, "name", "label") ?? null);
    const coords = rowCoords(row);
    if (!id || name === null || !coords) return [];
    return [
      {
        key: id,
        name,
        lat: coords.lat,
        lng: coords.lng,
        ...(rowText(row, "kind") === "home" ? { isHome: true } : {}),
      },
    ];
  });
}

export function homeAnchor(anchors: readonly NamedPlace[]): NamedPlace | null {
  return anchors.find((anchor) => anchor.isHome === true) ?? null;
}

export function placeVocabulary(
  row: PlaceRow,
  home: NamedPlace | null
): string[] {
  const words: string[] = [];
  const member = readableName(rowText(row, "name", "label") ?? null);
  if (member !== null) words.push(member);
  const gazetteer = gazetteerNameFrom(rowText(row, "address_json") ?? null);
  if (gazetteer !== null) words.push(gazetteer);
  const coords = rowCoords(row);
  const band =
    home && coords
      ? homeBand(distanceKm(coords.lat, coords.lng, home.lat, home.lng))
      : null;
  if (band === "at home" || band === "around town") {
    words.push(...PLACE_HOME_TERMS, band);
  }
  return words;
}

export function placeLabel(
  row: PlaceRow,
  anchors: readonly NamedPlace[]
): string {
  return placePhrase({
    placeName: rowText(row, "name", "label"),
    gazetteerName: gazetteerNameFrom(rowText(row, "address_json") ?? null),
    ...rowCoords(row),
    namedPlaces: anchors,
    context: "private",
  }).text;
}

export function noLocationAsked(query: string): boolean {
  const asked = query.trim().toLowerCase();
  if (asked === "") return false;
  return PLACE_NO_LOCATION_TERMS.some(
    (term) => term.includes(asked) || asked.includes(term)
  );
}
