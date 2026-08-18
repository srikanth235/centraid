/*
 * NEAREST SETTLEMENT, from a coordinate, on this device.
 *
 * Rung 2 of the place-phrase ladder (`packages/blueprints/apps/photos/
 * place-phrase.ts`) is "near Truckee, CA". This module is the whole of how
 * Centraid knows that, and the shape of it is the point: a bundled dataset
 * (`gazetteer-data.ts`, GeoNames CC-BY — see that file's header) plus
 * arithmetic. There is no client, no key, no endpoint, and nothing to consent
 * to beyond turning the automation on. A reverse-geocoding API would answer
 * better and would also mean mailing a stranger the coordinates of a member's
 * home, their child's school, and every trailhead they have ever walked, one
 * request at a time. That trade is not available in this product, so the
 * answer is the one a 750 KB table can give.
 *
 * Pure and synchronous: same coordinate, same settlement, forever. The parse
 * of the vendored blob happens once, lazily, on first lookup.
 */

import { GAZETTEER_RECORDS } from "./gazetteer-data.js";

/**
 * The dataset's own identity, re-exported so a caller needs one import.
 *
 * `GAZETTEER_ROW_COUNT` is the count the data file declares — pinned against
 * the table actually parsed by `gazetteer.test.ts`, so a regeneration that
 * silently drops rows fails rather than quietly answering worse.
 */
export { GAZETTEER_ROW_COUNT, GAZETTEER_SNAPSHOT } from "./gazetteer-data.js";

/** Stable id for the vendored dataset, stamped onto every record written. */
export const GAZETTEER_SOURCE = "geonames-cities15000";

/**
 * How far a settlement may be and still name where a photograph was taken.
 *
 * Fifty kilometres, which is further than it first sounds and deliberately so.
 * The dataset holds settlements over 15,000 people, so in most of the world the
 * nearest one is the nearest TOWN — and the photographs this rung exists for
 * are the ones taken away from towns. A trailhead 20 km up the road from
 * Truckee is "near Truckee" to everyone who drove there; that is how people
 * talk about where they went, and refusing to say it because the coordinate is
 * not inside the town limits would leave the phrase at "A place with no name
 * yet" for exactly the photographs that most needed a word. The hedge lives in
 * the copy: `place-phrase.ts` prints "near", never "in".
 *
 * Beyond 50 km the claim stops being about a neighbourhood and starts being
 * about a region, which this rung does not model, so the lookup returns
 * nothing and the ladder falls through to a phrase relative to a place the
 * member named — which at that range is the more informative sentence anyway.
 */
export const GAZETTEER_MAX_KM = 50;

/**
 * Inside this much of the nearest candidate's distance, two settlements are
 * equidistant as far as a phrase is concerned, and the more populous one wins.
 *
 * A kilometre, because that is roughly the width of the towns themselves: when
 * a point falls between two of them the arithmetic's winner is decided by
 * whichever centroid GeoNames happened to place, and "near Reno" tells a reader
 * more than "near Sparks" does even when Sparks is 400 m closer. Population is
 * a proxy for recognisability, which is the only thing this phrase is for.
 */
const TIE_BAND_KM = 1;

/** Mean Earth radius (IUGG), km — the same constant `place-phrase.ts` uses. */
const EARTH_RADIUS_KM = 6371.0088;

/** Kilometres per degree of latitude. Constant enough to size a search window. */
const KM_PER_DEGREE_LAT = 111.195;

/** One settlement, as the vendored table stores it. */
export interface Settlement {
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
  /** Two-letter state code for US rows; `""` everywhere else, on purpose. */
  readonly admin: string;
  /** ISO 3166-1 alpha-2 country code. */
  readonly country: string;
  /** Population in thousands, rounded. Tie-breaking only. */
  readonly populationThousands: number;
}

/** A settlement that answered for a coordinate, with how far away it was. */
export interface GazetteerHit extends Settlement {
  /** Great-circle kilometres from the queried coordinate, to one decimal. */
  readonly distanceKm: number;
  /** What a surface prints — `"Truckee, CA"` or, outside the US, `"Kyoto"`. */
  readonly displayName: string;
}

interface Table {
  readonly lat: Float64Array;
  readonly lng: Float64Array;
  readonly pop: Int32Array;
  readonly name: readonly string[];
  readonly admin: readonly string[];
  readonly country: readonly string[];
}

let table: Table | undefined;

/** Parse the vendored blob into typed columns. Called once, on first lookup. */
function load(): Table {
  if (table !== undefined) return table;
  const records = GAZETTEER_RECORDS.split("~");
  const count = records.length;
  const lat = new Float64Array(count);
  const lng = new Float64Array(count);
  const pop = new Int32Array(count);
  const name: string[] = Array.from({ length: count }, () => "");
  const admin: string[] = Array.from({ length: count }, () => "");
  const country: string[] = Array.from({ length: count }, () => "");
  for (let i = 0; i < count; i += 1) {
    const parts = records[i]!.split("|");
    name[i] = parts[0] ?? "";
    lat[i] = Number(parts[1]);
    lng[i] = Number(parts[2]);
    admin[i] = parts[3] ?? "";
    country[i] = parts[4] ?? "";
    pop[i] = Number(parts[5]) | 0;
  }
  table = { lat, lng, pop, name, admin, country };
  return table;
}

/** How many settlements the loaded table holds — pinned against the data file. */
export function gazetteerSize(): number {
  return load().name.length;
}

/**
 * Great-circle distance in kilometres, by haversine.
 *
 * Deliberately a second copy of `place-phrase.ts`'s `distanceKm` rather than an
 * import: that module has no imports at all by design (it is compiled into both
 * the web client and the Expo bundle), and this one is compiled into a handler
 * bundle that must not reach into a blueprint. Twelve lines of arithmetic in two
 * places is the cheaper of the two prices.
 */
function distanceKm(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number
): number {
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Index of the first row whose latitude is >= `value`. Rows are lat-sorted. */
function lowerBound(lat: Float64Array, value: number): number {
  let lo = 0;
  let hi = lat.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lat[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * What a surface prints for a settlement.
 *
 * `"Truckee, CA"` in the United States, where GeoNames' admin1 is the postal
 * state code a reader already knows. `"Kyoto"` everywhere else — see the data
 * file's header for why no other admin code is stored, and note that a country
 * name would not earn its bytes here either: these are the member's own
 * photographs, and a person looking at their own trip to Japan does not need to
 * be told which country Kyoto is in.
 */
export function gazetteerDisplayName(settlement: {
  name: string;
  admin: string;
}): string {
  return settlement.admin === ""
    ? settlement.name
    : `${settlement.name}, ${settlement.admin}`;
}

/**
 * The settlement that names a coordinate, or `null` when none is near enough.
 *
 * Scans only the rows inside a latitude window of `maxKm` — a binary search
 * plus a few dozen comparisons rather than 23,527 haversines, which matters
 * because a backfill runs this once per place row and the handler holds the
 * worker while it does. Longitude is deliberately NOT windowed: the band holds
 * every candidate whatever its longitude, so a coordinate beside the
 * antimeridian needs no wrap-around special case to be correct.
 *
 * `null` for a non-finite coordinate. A missing coordinate is not a claim that
 * a photograph was taken nowhere.
 */
export function nearestSettlement(
  lat: number,
  lng: number,
  maxKm: number = GAZETTEER_MAX_KM
): GazetteerHit | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const t = load();
  const window = maxKm / KM_PER_DEGREE_LAT;
  const from = lowerBound(t.lat, lat - window);
  const upper = lat + window;
  let best = -1;
  let bestKm = Number.POSITIVE_INFINITY;
  const near: number[] = [];
  for (let i = from; i < t.lat.length && t.lat[i]! <= upper; i += 1) {
    const km = distanceKm(lat, lng, t.lat[i]!, t.lng[i]!);
    if (km > maxKm) continue;
    near.push(i);
    if (km < bestKm) {
      bestKm = km;
      best = i;
    }
  }
  if (best < 0) return null;
  // Tie-break toward the settlement more readers would recognise.
  let chosen = best;
  let chosenKm = bestKm;
  for (const i of near) {
    const km = distanceKm(lat, lng, t.lat[i]!, t.lng[i]!);
    if (km > bestKm + TIE_BAND_KM) continue;
    const pop = t.pop[i] ?? 0;
    const chosenPop = t.pop[chosen] ?? 0;
    const better =
      pop > chosenPop ||
      (pop === chosenPop &&
        (km < chosenKm ||
          // Two rows with the same population at the same distance: order by
          // name so the answer never depends on table order.
          (km === chosenKm && (t.name[i] ?? "") < (t.name[chosen] ?? ""))));
    if (better) {
      chosen = i;
      chosenKm = km;
    }
  }
  const settlement: Settlement = {
    name: t.name[chosen]!,
    lat: t.lat[chosen]!,
    lng: t.lng[chosen]!,
    admin: t.admin[chosen]!,
    country: t.country[chosen]!,
    populationThousands: t.pop[chosen]!,
  };
  return {
    ...settlement,
    distanceKm: Math.round(chosenKm * 10) / 10,
    displayName: gazetteerDisplayName(settlement),
  };
}
