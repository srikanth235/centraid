// WHERE A PHOTOGRAPH WAS TAKEN, as a phrase a person would say out loud.
//
// A place is a phrase first and a map second. The vault knows a coordinate;
// a member knows "Grandma's house". Those are not the same fact, and printing
// the first where the second belongs is the single worst thing this app can do
// with a location: "37.44190, -122.14300" looks like an answer, reads as
// surveillance, and tells the person who took the photograph nothing they did
// not already know. So every surface that shows a location asks this module for
// words, and the coordinate stays behind an explicit "exact location" action.
//
// THE LADDER, in falling order of how much the vault actually knows:
//
//  1. The member's own name for the place — "Grandma's house". A name a person
//     entered outranks everything derived, always, and is never overwritten.
//  2. A gazetteer name, when the opt-in automation is enabled — "near Truckee,
//     CA". Hedged with "near" because a settlement name is a neighbourhood-
//     scale claim about a point, not the point itself.
//  3. A phrase relative to a place the member DID name — "3.4 km NE of Home".
//     This is the rung that makes an unnamed coordinate legible on day one
//     with no gazetteer and no network: a member who named where they live can
//     situate anything within a day's drive of it.
//  4. "A place with no name yet". Honest, and short.
//
// WHY IMPORT-FREE. Same reason as `place-map.ts`: both Photos surfaces render
// locations — the web app and the Expo client — and the phrase must be the
// same sentence on both or the two products have drifted on what they know.
// Native bundles this file straight out of the blueprints package, so it must
// not reach into the web app's explicit-`.ts` module graph, a stylesheet, or a
// token. Words in, words out; which is also why it is cheap to test.
//
// WHY THE RELATIVE RUNG IS SUPPRESSED WHEN SHARED. "3.4 km NE of Home" is a
// sentence about the reader's own home, and in an export or a shared album the
// reader is somebody else — the phrase would hand a stranger a bearing and a
// distance to where the member lives, which is strictly worse than the
// coordinate it was invented to avoid, because it reads as harmless. So in
// `"shared"` context rung 3 is skipped entirely and the phrase falls to rung 4.
// Rungs 1 and 2 survive: a member-entered name and a settlement name are what
// the member chose to say about the place.

/** A place the member has named, as an anchor for a relative phrase. */
export interface NamedPlace {
  /** The `core_place` id — carried so a caller can key off the anchor. */
  key: string;
  /** A name a person would recognise. Coordinate-shaped labels do not belong
   *  here: filter with the caller's `readableName` before passing them in. */
  name: string;
  lat: number;
  lng: number;
  /** True for the place `core_place.kind` calls `'home'`. Preferred as the
   *  anchor within `HOME_ANCHOR_KM`, and the only anchor a relative phrase is
   *  suppressed to protect. */
  isHome?: boolean;
}

/** Who is going to read the phrase. Defaults to `"private"` everywhere: the
 *  member's own screens. `"shared"` is an export, a shared album, a link. */
export type PlacePhraseContext = "private" | "shared";

/** Which rung of the ladder answered. Callers style by this rather than
 *  sniffing the text — a derived phrase is a weaker claim than a name. */
export type PlacePhraseSource = "member" | "gazetteer" | "relative" | "none";

export interface PlacePhrase {
  text: string;
  source: PlacePhraseSource;
}

export interface PlacePhraseInput {
  /** The linked place's stored name. Coordinate-shaped labels fall through. */
  placeName?: string | null;
  /** A settlement name from the opt-in gazetteer automation, when enabled. */
  gazetteerName?: string | null;
  lat?: number | null;
  lng?: number | null;
  /** The member's named places, as anchors for the relative rung. */
  namedPlaces?: readonly NamedPlace[];
  context?: PlacePhraseContext;
}

/**
 * Rung 4. The vault knows exactly where these were taken and has no label to
 * print, and the copy says which of the two is true — it is not "Unknown".
 *
 * Deliberately duplicated from `shared-copy.ts`'s `PLACE_UNNAMED` rather than
 * imported, for the same reason `readableName`'s regex is duplicated: this
 * module has no imports at all, on purpose. The two strings must stay
 * byte-identical; they are the same sentence in the same product.
 */
export const PLACE_NO_NAME = "A place with no name yet";

/**
 * Is this "name" just the coordinate wearing a label's clothes?
 *
 * The display-side twin of `isCoordinateLabel` in the vault's media.ts and of
 * `readableName` in `place-map.ts` — deliberately duplicated a third time
 * rather than imported, because the thing being matched is a four-line regex
 * and this module links nothing (see the header). Every place minted from GPS
 * carries a name of this shape until a member renames it.
 */
function isCoordinateLabel(text: string): boolean {
  return /^-?\d{1,3}\.\d+,\s*-?\d{1,3}\.\d+$/u.test(text);
}

/** A name worth printing, or null. Trims, and refuses a coordinate. */
function printableName(name: string | null | undefined): string | null {
  const text = (name ?? "").trim();
  if (text === "") return null;
  return isCoordinateLabel(text) ? null : text;
}

/** Mean Earth radius (IUGG), in kilometres. A sphere is exact enough here: the
 *  ellipsoid disagrees by ~0.3%, which is under the rounding of every phrase
 *  this module prints. */
const EARTH_RADIUS_KM = 6371.0088;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Great-circle distance in kilometres, by the haversine formula.
 *
 * Haversine rather than the equirectangular shortcut because a phrase may span
 * a few hundred kilometres, where the flat approximation is off by enough to
 * change the printed number. Returns NaN if any coordinate is not finite —
 * callers treat that as "no distance known", never as zero.
 */
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

/**
 * Initial bearing from A to B, in degrees clockwise from true north.
 *
 * The INITIAL bearing, not the average one: it is what "NE of Home" means when
 * you stand at Home and point. Returns NaN on a non-finite coordinate.
 */
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

/** The eight points of the compass, from north, clockwise. */
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

export type CompassPoint = (typeof COMPASS)[number];

/**
 * A bearing as one of eight compass points, or null if there is no bearing.
 *
 * EIGHT points, not sixteen: "NNE" is navigator's vocabulary, and nobody says
 * it about a weekend. Each point covers 45°, so the boundaries land on the
 * odd multiples of 22.5° and the rounding is a single divide.
 */
export function compassPoint(bearing: number): CompassPoint | null {
  if (!Number.isFinite(bearing)) return null;
  const normalised = ((bearing % 360) + 360) % 360;
  return COMPASS[Math.round(normalised / 45) % 8]!;
}

/** How far from home a photograph was taken, in words a caller can branch on. */
export type HomeBand = "at home" | "around town" | "away";

/**
 * The radius inside which a photograph counts as taken AT home — a house, its
 * garden, the pavement outside. Deliberately far looser than the ~11m place
 * identity rung and looser again than the ~170m adoption radius in the vault's
 * `findOrCreatePlaceTx`: those answer "is this the same place", this answers
 * "was this at home", and a photograph from the end of the street was.
 */
const AT_HOME_KM = 0.5;

/**
 * The radius inside which a photograph is still everyday life rather than a
 * trip. Twenty-five kilometres is about the span of a city and its errands —
 * the school, the shops, the park on the other side of town.
 */
const AROUND_TOWN_KM = 25;

/**
 * Which band a distance from home falls in.
 *
 * Null for a distance that is not a number: an unknown distance is not a claim
 * that a photograph was taken away from home, and this function will not make
 * one. Exported now because later waves group and title by this band.
 */
export function homeBand(km: number): HomeBand | null {
  if (!Number.isFinite(km)) return null;
  if (km <= AT_HOME_KM) return "at home";
  if (km <= AROUND_TOWN_KM) return "around town";
  return "away";
}

/**
 * How near an anchor has to be before the bearing stops being worth printing.
 *
 * At a hundred metres the compass point is noise — the coordinate's own
 * accuracy is the same order — so the phrase drops it and says "At Home",
 * which is what a person would say standing there.
 */
const AT_ANCHOR_KM = 0.1;

/**
 * How near the home place has to be to be PREFERRED as the anchor over a
 * closer named place.
 *
 * "2 km NE of Home" situates a reader instantly; "600 m S of Dentist" makes
 * them work out where the dentist is. So inside a town's span home wins even
 * when something else is nearer. Beyond it, the nearest anchor is the more
 * informative one and takes over.
 */
const HOME_ANCHOR_KM = 25;

/**
 * How far an anchor may be before a relative phrase stops being a place at all.
 *
 * "3,900 km NE of Home" is trivia, not a location: at that range the bearing
 * and the distance together still leave a reader with no idea where they are
 * looking. Roughly a long day's drive is the ceiling; past it the phrase falls
 * to the honest fallback and waits for a gazetteer.
 */
const RELATIVE_MAX_KM = 250;

/**
 * A distance in the units a person would use for it.
 *
 * Three registers, because precision that outruns the claim is its own kind of
 * lie: metres to the nearest fifty below a kilometre, one decimal up to ten
 * kilometres ("3.4 km" is how far the lake is), whole kilometres above that
 * ("248 km", never "248.1 km" — nobody drives to a tenth of a kilometre).
 */
export function formatDistance(km: number): string | null {
  if (!Number.isFinite(km) || km < 0) return null;
  if (km < 1) {
    const metres = Math.round((km * 1000) / 50) * 50;
    // 990m rounds to 1000, and "1000 m" is a number nobody says out loud.
    if (metres < 1000) return `${metres} m`;
  }
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

/**
 * Rung 3: a phrase relative to the nearest place the member named, or null
 * when no anchor is near enough to say anything useful.
 *
 * Exported for the tests and for later waves that phrase a whole trip; the
 * suppression rule lives in `placePhrase`, not here, so a caller reaching for
 * this function directly has to decide the context on purpose.
 */
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
  // Home wins inside a town's span; otherwise the nearest anchor does. (Every
  // home candidate is also a `nearest` candidate, so `nearest` is set whenever
  // `home` is.)
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

/**
 * The phrase to PRINT for a location — the whole ladder, in one call.
 *
 * Pure: same inputs, same sentence, no clock and no locale lookup. The `source`
 * says which rung answered, so a surface can render a derived phrase more
 * quietly than a name the member typed. The text is never coordinate-shaped for
 * any input: that is the invariant the tests hold, and the reason this function
 * exists at all.
 */
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
  // "near", because a settlement name locates a point in a neighbourhood and
  // does not claim to BE the point.
  if (gazetteer !== null) {
    return { text: `near ${gazetteer}`, source: "gazetteer" };
  }

  if (context === "private" && lat != null && lng != null) {
    const relative = relativePhrase(lat, lng, namedPlaces);
    if (relative !== null) return { text: relative, source: "relative" };
  }

  return { text: PLACE_NO_NAME, source: "none" };
}

/**
 * The coordinate, spelled out — the ONE place in this module that prints
 * digits, and only ever behind an explicit "exact location" action a member
 * took on purpose. Five decimals is about a metre, which is the finest thing
 * any of these coordinates could honestly mean.
 *
 * Null when there is no coordinate to spell, so a caller cannot render the
 * action for an asset that has nothing behind it.
 */
export function exactLocation(
  lat: number | null | undefined,
  lng: number | null | undefined
): string | null {
  if (lat == null || lng == null) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}
