export interface NamedPlace {
  key: string;
  name: string;
  lat: number;
  lng: number;
  isHome?: boolean;
}

export type PlacePhraseContext = "private" | "shared";

export type PlacePhraseSource = "member" | "gazetteer" | "relative" | "none";

export interface PlacePhrase {
  text: string;
  source: PlacePhraseSource;
}

export interface PlacePhraseInput {
  placeName?: string | null;
  gazetteerName?: string | null;
  lat?: number | null;
  lng?: number | null;
  namedPlaces?: readonly NamedPlace[];
  context?: PlacePhraseContext;
}

export const PLACE_NO_NAME = "A place with no name yet";

function isCoordinateLabel(text: string): boolean {
  return /^-?\d{1,3}\.\d+,\s*-?\d{1,3}\.\d+$/u.test(text);
}

function printableName(name: string | null | undefined): string | null {
  const text = (name ?? "").trim();
  if (text === "") return null;
  return isCoordinateLabel(text) ? null : text;
}

const EARTH_RADIUS_KM = 6371.0088;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export function distanceKm(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number
): number {
  if (
    !Number.isFinite(aLat) ||
    !Number.isFinite(aLng) ||
    !Number.isFinite(bLat) ||
    !Number.isFinite(bLng)
  ) {
    return NaN;
  }
  const dLat = toRadians(bLat - aLat);
  const dLng = toRadians(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(aLat)) *
      Math.cos(toRadians(bLat)) *
      Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDegrees(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number
): number {
  if (
    !Number.isFinite(aLat) ||
    !Number.isFinite(aLng) ||
    !Number.isFinite(bLat) ||
    !Number.isFinite(bLng)
  ) {
    return NaN;
  }
  const dLng = toRadians(bLng - aLng);
  const lat1 = toRadians(aLat);
  const lat2 = toRadians(bLat);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

export type CompassPoint = (typeof COMPASS)[number];

export function compassPoint(bearing: number): CompassPoint | null {
  if (!Number.isFinite(bearing)) return null;
  const normalised = ((bearing % 360) + 360) % 360;
  return COMPASS[Math.round(normalised / 45) % 8]!;
}

export type HomeBand = "at home" | "around town" | "away";

const AT_HOME_KM = 0.5;

const AROUND_TOWN_KM = 25;

export function homeBand(km: number): HomeBand | null {
  if (!Number.isFinite(km)) return null;
  if (km <= AT_HOME_KM) return "at home";
  if (km <= AROUND_TOWN_KM) return "around town";
  return "away";
}

const AT_ANCHOR_KM = 0.1;

const HOME_ANCHOR_KM = 25;

const RELATIVE_MAX_KM = 250;

export function formatDistance(km: number): string | null {
  if (!Number.isFinite(km) || km < 0) return null;
  if (km < 1) {
    const metres = Math.round((km * 1000) / 50) * 50;
    if (metres < 1000) return `${metres} m`;
  }
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

export function relativePhrase(
  lat: number,
  lng: number,
  namedPlaces: readonly NamedPlace[]
): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  let nearest: { place: NamedPlace; km: number } | null = null;
  let home: { place: NamedPlace; km: number } | null = null;
  for (const place of namedPlaces) {
    if (printableName(place.name) === null) continue;
    const km = distanceKm(lat, lng, place.lat, place.lng);
    if (!Number.isFinite(km)) continue;
    if (nearest === null || km < nearest.km) nearest = { place, km };
    if (place.isHome === true && (home === null || km < home.km)) {
      home = { place, km };
    }
  }
  const anchor = home !== null && home.km <= HOME_ANCHOR_KM ? home : nearest;
  if (anchor === null || anchor.km > RELATIVE_MAX_KM) return null;
  const name = printableName(anchor.place.name);
  if (name === null) return null;
  if (anchor.km <= AT_ANCHOR_KM) return `At ${name}`;
  const distance = formatDistance(anchor.km);
  const point = compassPoint(
    bearingDegrees(anchor.place.lat, anchor.place.lng, lat, lng)
  );
  if (distance === null || point === null) return null;
  return `${distance} ${point} of ${name}`;
}

export function placePhrase({
  placeName,
  gazetteerName,
  lat,
  lng,
  namedPlaces = [],
  context = "private",
}: PlacePhraseInput): PlacePhrase {
  const member = printableName(placeName);
  if (member !== null) return { text: member, source: "member" };

  const gazetteer = printableName(gazetteerName);
  if (gazetteer !== null) {
    return { text: `near ${gazetteer}`, source: "gazetteer" };
  }

  if (context === "private" && lat != null && lng != null) {
    const relative = relativePhrase(lat, lng, namedPlaces);
    if (relative !== null) return { text: relative, source: "relative" };
  }

  return { text: PLACE_NO_NAME, source: "none" };
}

export function gazetteerNameFrom(
  addressJson: string | null | undefined
): string | null {
  if (typeof addressJson !== "string" || addressJson === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(addressJson);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const gazetteer = (parsed as { gazetteer?: unknown }).gazetteer;
  if (gazetteer === null || typeof gazetteer !== "object") return null;
  const name = (gazetteer as { name?: unknown }).name;
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed === "" ? null : trimmed;
}

export function exactLocation(
  lat: number | null | undefined,
  lng: number | null | undefined
): string | null {
  if (lat == null || lng == null) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}
