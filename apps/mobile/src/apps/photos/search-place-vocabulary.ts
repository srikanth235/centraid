// WHAT A PLACE ANSWERS TO WHEN A MEMBER SEARCHES FOR IT (issue #816).
//
// `search-hits.ts` builds the rows above the grid; this module answers the one
// question those rows ask about a place that is genuinely hard: which WORDS
// stand for it, and what should it be CALLED once it is found. Those are two
// different answers over the same raw `core.place` row — a place found by
// "tahoe" is still titled "the shore" if that is what the member called it —
// and they are the deepest readers of the row's own columns, which is why they
// live together here rather than inside the hit-building loop.
//
// It is a leaf on purpose: no react-native, no replica, no navigation, and
// nothing imported back out of `search-hits.ts`. Everything it needs from the
// blueprints is the phrase ladder itself (`place-phrase.ts`), which both clients
// share so the phone and the desktop cannot drift on what a place is called.
//
// The vocabulary has three sources, and NONE of them is a coordinate:
//
//   1. the member's own name for the place, when `readableName` says the column
//      holds a name rather than the digits `findOrCreatePlaceTx` minted;
//   2. the settlement the opt-in gazetteer automation derived, dug out of
//      `address_json` — so "tahoe" finds a place the member named something
//      entirely of their own;
//   3. the home vocabulary, for a place inside the "at home"/"around town" band
//      of the place the member DECLARED to be home — which is how somebody who
//      cannot recall the name of the park still finds the afternoon at it.
//
// There is deliberately no fourth source and no fallback: with no home declared
// the home vocabulary answers nothing, because "near home" is a claim about a
// place a person named and guessing which one would answer a question nobody
// asked.
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

/**
 * One field of a raw replica row as a non-blank string, or undefined — the keys
 * tried in order, so a physical column wins over a legacy fixture spelling.
 *
 * Lives here, and is imported back by `search-hits.ts` for the party/collection
 * rows, because this module is the deepest reader of raw rows in the search
 * path: every rung of the place ladder is one of these lookups. One reader for
 * every row shape keeps "a blank column is an absent column" a single rule.
 */
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

/** A raw `core_place` row's coordinate pair, or null. Physical columns first
 *  (`geo_lat`/`geo_lng`, the schema's own names — the phone reads rows RAW),
 *  with the legacy fixture spellings behind them, the same chain
 *  `places-model.ts` reads. */
export function rowCoords(row: PlaceRow): { lat: number; lng: number } | null {
  const lat = row.geo_lat ?? row.latitude ?? row.lat;
  const lng = row.geo_lng ?? row.longitude ?? row.lng;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

/**
 * The anchors a phrase may be relative to: the places carrying a name a person
 * would recognise AND a coordinate. Read off the same rows the hits come from,
 * so search needs no second query to phrase one of them.
 */
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

/** The one place the member declared to be home, or null. */
export function homeAnchor(anchors: readonly NamedPlace[]): NamedPlace | null {
  return anchors.find((anchor) => anchor.isHome === true) ?? null;
}

/**
 * Every word this place answers to (see the file header). Matched by the
 * caller's own token search, so this returns the words and takes no view on how
 * they are compared.
 */
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
  // "away" is deliberately not vocabulary: a photograph 250 km from home is not
  // near home in any register a person uses.
  if (band === "at home" || band === "around town") {
    words.push(...PLACE_HOME_TERMS, band);
  }
  return words;
}

/**
 * What to CALL a place once a query has found it — always the ladder, never the
 * column and never the coordinate.
 *
 * A place found by its gazetteer name or by "near home" still has to be titled
 * with something a person would say, and a place whose `name` column holds the
 * digits `findOrCreatePlaceTx` minted is titled by the rung below instead.
 */
export function placeLabel(
  row: PlaceRow,
  anchors: readonly NamedPlace[]
): string {
  return placePhrase({
    placeName: rowText(row, "name", "label"),
    gazetteerName: gazetteerNameFrom(rowText(row, "address_json") ?? null),
    ...rowCoords(row),
    namedPlaces: anchors,
    // Said out loud, but only on this member's own search results — so the
    // relative rung is allowed here. A phrase that leaves the device goes
    // through `share-place.ts` instead (#816).
    context: "private",
  }).text;
}

/**
 * Is this query asking for the photographs with no place at all?
 *
 * Matched as a PHRASE rather than by token, unlike everything else in the search
 * path: these terms are two-word phrases whose halves mean nothing on their own,
 * and "place" as a bare token would hit every place row's own vocabulary.
 */
export function noLocationAsked(query: string): boolean {
  const asked = query.trim().toLowerCase();
  if (asked === "") return false;
  return PLACE_NO_LOCATION_TERMS.some(
    (term) => term.includes(asked) || asked.includes(term)
  );
}
