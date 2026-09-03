// NEAREST SETTLEMENT on this device: a bundled table plus arithmetic. A
// reverse-geocoding API answers better and mails a stranger the coordinates of
// a member's home, so that trade is not available here.

import { GAZETTEER_RECORDS } from "./gazetteer-data.js";

export { GAZETTEER_ROW_COUNT, GAZETTEER_SNAPSHOT } from "./gazetteer-data.js";

export const GAZETTEER_SOURCE = "geonames-cities15000";

/** Wide on purpose; the hedge is in the copy, which prints "near", never "in". */
export const GAZETTEER_MAX_KM = 50;

/** Inside this band the more populous wins: a kilometre is the width of the
 *  towns, so the closer one is only whichever centroid GeoNames chose. */
const TIE_BAND_KM = 1;

const EARTH_RADIUS_KM = 6371.0088;

const KM_PER_DEGREE_LAT = 111.195;

export interface Settlement {
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
  readonly admin: string;
  readonly country: string;
  readonly populationThousands: number;
}

export interface GazetteerHit extends Settlement {
  readonly distanceKm: number;
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

export function gazetteerSize(): number {
  return load().name.length;
}

/** A deliberate second copy: this bundle must not reach a blueprint. */
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

/** No country name, on purpose. */
export function gazetteerDisplayName(settlement: {
  name: string;
  admin: string;
}): string {
  return settlement.admin === ""
    ? settlement.name
    : `${settlement.name}, ${settlement.admin}`;
}

/** Latitude window only; longitude deliberately NOT windowed, so there is no
 *  antimeridian case. */
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
