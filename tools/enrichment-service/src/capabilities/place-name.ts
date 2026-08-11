import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type {
  ItemResult,
  ModelId,
  PlaceItem,
  PlaceNameResult,
} from "../types.js";

// place-name is a GAZETTEER LOOKUP, not a model: a coordinate in, the name of
// the nearest settlement out. No ONNX, no weights, no runtime/ dependency —
// just a sorted table and a bounded scan.
//
// It is a capability rather than a library because of where it has to run.
// A usable world gazetteer is tens of megabytes; that cannot live in a phone
// bundle or a browser, and it must never live behind a network call, because
// the coordinates being looked up ARE the member's location history. Putting
// it here means the lookup happens on the same loopback-only service every
// other derivation goes through, under the same consent tier, with the same
// versioned model id so a better table supersedes an older one's answers.
//
// HONEST ABSENCE, same as weights (issue #724 W8): with no gazetteer file
// installed the capability is simply not advertised. A service that answered
// "Unknown" or guessed the nearest continent would be worse than one that
// says nothing, because the gateway would stamp the guess and stop asking.
export const PLACE_NAME_MODEL_ID: ModelId = "gazetteer@1";

/** Where the table lives under the models dir, and its format:
 *
 *     name <TAB> region <TAB> lat <TAB> lng <TAB> population
 *
 * One settlement per line, `#` comments and blank lines ignored. TSV rather
 * than JSON because the real tables are hundreds of thousands of rows and a
 * line-oriented file streams and diffs; the parse below is a split, not a
 * parser. See docs/enrichment-service.md for installing a real one. */
const GAZETTEER_FILE = path.join("gazetteer", "places.tsv");

export function gazetteerPath(modelsDir: string): string {
  return path.join(modelsDir, GAZETTEER_FILE);
}

export function gazetteerPresent(modelsDir: string): boolean {
  return existsSync(gazetteerPath(modelsDir));
}

interface Settlement {
  name: string;
  region: string | null;
  lat: number;
  lng: number;
  population: number;
}

/**
 * How far a settlement may reach, in kilometres, by how many people live
 * there.
 *
 * A fixed radius is what makes naive reverse geocoding embarrassing in both
 * directions: at 5km a coordinate in open countryside gets no name at all,
 * and at 50km a hamlet claims the next valley. Big places genuinely do name
 * the ground around them — a photograph 20km outside a city of a million is
 * fairly described by that city; one 20km from a village of four hundred is
 * not anywhere near that village. The square root keeps the curve gentle:
 * a thousandfold more people is about thirty times the reach, not a thousand.
 */
function reachKm(population: number): number {
  return Math.min(60, 2 + Math.sqrt(Math.max(population, 0)) / 40);
}

const EARTH_RADIUS_KM = 6371;

function haversineKm(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number
): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The parsed table, cached by the path it came from.
 *
 * A gazetteer is immutable once installed and the service is long-lived, so
 * re-reading tens of megabytes per batch would be the whole cost of this
 * capability. Keyed by path rather than a bare module-level variable so a
 * test can point at its own fixture without poisoning the next one.
 */
const CACHE = new Map<string, Settlement[]>();

export function loadGazetteer(modelsDir: string): Settlement[] {
  const file = gazetteerPath(modelsDir);
  const cached = CACHE.get(file);
  if (cached) return cached;
  const rows: Settlement[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [name, region, lat, lng, population] = trimmed.split("\t");
    const latitude = Number(lat);
    const longitude = Number(lng);
    // A malformed row is skipped, not fatal. A gazetteer is third-party data
    // and one bad line must not take down a capability that has hundreds of
    // thousands of good ones.
    if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude))
      continue;
    rows.push({
      name,
      region: region ? region : null,
      lat: latitude,
      lng: longitude,
      population: Number.isFinite(Number(population)) ? Number(population) : 0,
    });
  }
  CACHE.set(file, rows);
  return rows;
}

/** Test seam: forget what was parsed, so a fixture can be rewritten. */
export function clearGazetteerCache(): void {
  CACHE.clear();
}

/**
 * The best name for a coordinate, or `null` when nothing reaches it.
 *
 * "Best" is not "nearest": a settlement only counts if the coordinate is
 * inside its own reach (above), and among those the one whose distance is the
 * smallest FRACTION of its reach wins. That is what makes a city beat the
 * suburb you are technically closer to when you are plainly in the city, and
 * the suburb beat the city when you are standing in the suburb.
 */
export function nameFor(
  table: readonly Settlement[],
  lat: number,
  lng: number
): { name: string; region: string | null; confidence: number } | null {
  let best: { row: Settlement; ratio: number } | null = null;
  for (const row of table) {
    // A cheap rectangular reject before the trigonometry. At 60km the box is
    // generous enough that it can never exclude a real hit.
    if (Math.abs(row.lat - lat) > 0.6) continue;
    const reach = reachKm(row.population);
    const distance = haversineKm(lat, lng, row.lat, row.lng);
    if (distance > reach) continue;
    const ratio = distance / reach;
    if (!best || ratio < best.ratio) best = { row, ratio };
  }
  if (!best) return null;
  return {
    name: best.row.name,
    region: best.row.region,
    // Dead centre is 1, the edge of the reach is 0. Rounded because a
    // confidence is read, not computed against.
    confidence: Math.round((1 - best.ratio) * 100) / 100,
  };
}

export function placeName(
  item: PlaceItem,
  modelsDir: string
): ItemResult<PlaceNameResult> {
  try {
    if (!Number.isFinite(item.lat) || !Number.isFinite(item.lng)) {
      return { id: item.id, error: "lat/lng is not a finite number" };
    }
    const hit = nameFor(loadGazetteer(modelsDir), item.lat, item.lng);
    // `null` is an answer, not a failure — see the header. The gateway stamps
    // it and stops asking about the middle of the Pacific.
    return hit
      ? {
          id: item.id,
          name: hit.name,
          region: hit.region,
          confidence: hit.confidence,
        }
      : { id: item.id, name: null };
  } catch (error) {
    return {
      id: item.id,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
