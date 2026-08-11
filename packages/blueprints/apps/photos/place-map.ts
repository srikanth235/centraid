// WHERE THE PHOTOGRAPHS WERE TAKEN, as geometry — no renderer, no basemap.
//
// This module is the whole map except the drawing. It exists in this shape for
// one reason: Photos has TWO Places surfaces, the web shelf and the phone's
// map, and they had drifted into different products. The phone drew a real
// basemap through `react-native-maps`, which means the OS map vendor is asked
// for the neighbourhoods a member photographed; the web drew nothing at all,
// because a browser basemap would mean tile requests keyed to those same
// coordinates and the blueprint CSP denies remote hosts anyway
// (docs/traps/blueprint-csp.md). One surface leaked and the other was blank.
//
// So the geometry lives here and each surface renders it with the primitive it
// has — SVG in the browser, `react-native-svg` on the phone. A projection is
// arithmetic; it does not need a map vendor, and running the SAME arithmetic
// on both is what makes "the two Places surfaces agree" a fact rather than a
// resolution. Nothing here imports React, a stylesheet, or a token: it is
// numbers in and numbers out, which is also why it is cheap to test.
//
// What it deliberately does NOT do is draw land. A pin on a graticule states
// exactly what the vault knows — a coordinate — while a coastline under it
// would be a second claim, from a dataset, that nothing in this repo has
// verified. See `graticuleStep` for the honest version of "give the eye
// something to hold onto".
//
// WHAT MAKES IT READABLE is not the graticule, though. The first version of
// this map printed degrees down both margins, and degrees are cartographer's
// vocabulary: "39.0°N" tells a member nothing about a weekend they actually
// had. So the numbers came off the margins and the pin became the PHOTOGRAPH
// taken there (`MapPin.thumb`). Recognition does the work that labelling could
// not — you know your own kitchen window on sight, and you can see it sits far
// south of the lake. The grid stays as unlabelled rhythm, and the scale bar
// stays because "50 km" is a thing people say.

/** One place with coordinates and how many photographs it holds. */
export interface PlacePoint {
  /** The `core_place` id, or `""` for the unnamed group. */
  key: string;
  lat: number;
  lng: number;
  count: number;
  name: string | null;
  /** A photograph taken here, to draw AS the pin. See `MapPin.thumb`. */
  thumb?: string | null;
}

/** A place (or a merged group of places) at a position in the drawing box. */
export interface MapPin {
  /** The key of the place this pin OPENS — the largest of the group. */
  key: string;
  x: number;
  y: number;
  /** Photographs across every place merged into this pin. */
  count: number;
  /** The name of the largest place in the group. */
  name: string | null;
  /** How many distinct places this pin stands for. 1 for most pins. */
  places: number;
  /**
   * A photograph taken at this pin's place — what the pin is DRAWN AS.
   *
   * This is the load-bearing legibility decision. A dot at 39.0°N is
   * meaningless to anyone who does not read graticules, and a member does not
   * know a place by its coordinate; they know it because they recognise the
   * picture. So the pin is the picture, and the map becomes readable without
   * a single number on it. Same reason the merge keeps the LARGEST place's
   * thumb: the picture that stands for a group should be from the place most
   * of the photographs came from.
   */
  thumb?: string | null;
}

/** One graticule line: a meridian or a parallel, with the degree it names. */
export interface GraticuleLine {
  /** Pixel position along the axis this line crosses. */
  at: number;
  /** The degree value, for the label. */
  degrees: number;
}

export interface MapScale {
  /** The bar's length in pixels. */
  px: number;
  /** What that length measures on the ground. */
  km: number;
}

export interface MapProjection {
  pins: MapPin[];
  /** Meridians — vertical lines, `at` is an x. */
  meridians: GraticuleLine[];
  /** Parallels — horizontal lines, `at` is a y. */
  parallels: GraticuleLine[];
  scale: MapScale;
  /** The drawing box these coordinates are expressed in. */
  width: number;
  height: number;
}

export interface ProjectOptions {
  width: number;
  height: number;
  /** Blank margin inside the box, so an edge pin is not half-drawn. */
  padding?: number;
  /** Pins closer than this many pixels merge into one. */
  mergeDistance?: number;
}

/** Kilometres per degree of latitude. Constant enough at this scale — the
 *  ellipsoid's variation is under half a percent, well below one pixel. */
const KM_PER_DEG_LAT = 111.32;

/**
 * The smallest span, in degrees, a map is allowed to cover.
 *
 * A member whose photographs were all taken at one address has a zero-degree
 * bounding box, and fitting zero to a pixel box is a division by zero — but
 * the interesting part is what the fallback SAYS. Snapping to a tiny span
 * would draw one house at continental scale and imply a precision the ~11m
 * place identity does not have. Roughly a kilometre is the honest floor: the
 * pin lands in the middle of a box whose graticule admits how little is being
 * claimed.
 */
const MIN_SPAN_DEG = 0.01;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

/**
 * Degrees of longitude are shorter than degrees of latitude everywhere except
 * the equator, by the cosine of the latitude. Ignoring that is what makes
 * naive plots of northern trips look stretched sideways; a Tahoe roll at 39°N
 * would come out 29% too wide. The whole map is scaled at the centre
 * latitude's cosine, which is exact enough for a box this small and keeps the
 * projection to one multiply.
 */
function lngScaleAt(centreLat: number): number {
  return Math.max(0.05, Math.cos((centreLat * Math.PI) / 180));
}

/**
 * A "nice" step for the graticule: 1, 2 or 5 times a power of ten, chosen so
 * the span carries about four lines. Anything denser reads as hatching and
 * anything sparser stops being a reference at all. The 1/2/5 ladder is the
 * same one axis ticks have used since paper, and for the same reason — those
 * are the multiples people divide by in their heads.
 */
export function graticuleStep(spanDeg: number): number {
  const rough = spanDeg / 4;
  const power = 10 ** Math.floor(Math.log10(Math.max(rough, 1e-6)));
  const scaled = rough / power;
  const nice = scaled >= 5 ? 5 : scaled >= 2 ? 2 : 1;
  return nice * power;
}

/**
 * Round a distance DOWN to something a person would say out loud — 1, 2 or 5
 * times a power of ten. A scale bar reading "137 km" is arithmetic; one
 * reading "100 km" is a measurement the eye can carry to another part of the
 * map.
 */
function niceDistance(km: number): number {
  const power = 10 ** Math.floor(Math.log10(Math.max(km, 1e-6)));
  const scaled = km / power;
  const nice = scaled >= 5 ? 5 : scaled >= 2 ? 2 : 1;
  return nice * power;
}

/**
 * Project places into a drawing box.
 *
 * Pure: same points and box in, same numbers out, no clock and no randomness.
 * Points with a non-finite coordinate are dropped rather than thrown on —
 * a place whose latitude did not survive a round trip is a data problem for
 * the ledger to answer, not a reason for the map to refuse to draw the other
 * eight.
 */
export function projectPlaces(
  points: readonly PlacePoint[],
  { width, height, padding = 18, mergeDistance = 20 }: ProjectOptions
): MapProjection {
  const usable = points.filter(
    (point) => Number.isFinite(point.lat) && Number.isFinite(point.lng)
  );
  const boxWidth = Math.max(1, width - padding * 2);
  const boxHeight = Math.max(1, height - padding * 2);
  const empty: MapProjection = {
    pins: [],
    meridians: [],
    parallels: [],
    scale: { px: 0, km: 0 },
    width,
    height,
  };
  if (usable.length === 0) return empty;

  const lats = usable.map((point) => point.lat);
  const lngs = usable.map((point) => point.lng);
  const centreLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const lngScale = lngScaleAt(centreLat);

  // Span in "latitude-equivalent degrees" on both axes, so one unit is the
  // same distance whichever way it runs and the fit below cannot squash the
  // map. Longitude is pre-multiplied by the cosine; everything downstream
  // works in this one space and divides back out only for the labels.
  const latSpan = Math.max(Math.max(...lats) - Math.min(...lats), MIN_SPAN_DEG);
  const lngSpan = Math.max(
    (Math.max(...lngs) - Math.min(...lngs)) * lngScale,
    MIN_SPAN_DEG * lngScale
  );

  // ONE scale for both axes — the map keeps its aspect ratio and the spare
  // room becomes margin. Fitting each axis independently would stretch a
  // north-south trip into a square and quietly lie about the shape of it.
  const unitsPerPx = Math.max(latSpan / boxHeight, lngSpan / boxWidth);
  const centreLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;

  const project = (lat: number, lng: number): { x: number; y: number } => ({
    x: width / 2 + ((lng - centreLng) * lngScale) / unitsPerPx,
    // Latitude grows northward and y grows downward, hence the negation. This
    // is the one sign error that produces a map which looks plausible and is
    // upside down, so it gets a sentence of its own.
    y: height / 2 - (lat - centreLat) / unitsPerPx,
  });

  // Merge by PIXEL distance, not by degrees. Two places 11m apart are two rows
  // in the ledger and one dot on any map wide enough to hold a trip; whether
  // they collide is a question about the drawing, so it is asked in the
  // drawing's units. Points are merged into the largest pin first, so the name
  // that survives a merge is the one with the most photographs behind it
  // rather than whichever happened to be read first.
  const ordered = [...usable].sort(
    (a, b) => b.count - a.count || a.key.localeCompare(b.key)
  );
  const pins: MapPin[] = [];
  for (const point of ordered) {
    const { x, y } = project(point.lat, point.lng);
    const near = pins.find(
      (pin) => Math.hypot(pin.x - x, pin.y - y) <= mergeDistance
    );
    if (near) {
      near.count += point.count;
      near.places += 1;
    } else {
      pins.push({
        key: point.key,
        x,
        y,
        count: point.count,
        name: point.name,
        places: 1,
        thumb: point.thumb ?? null,
      });
    }
  }

  // The graticule spans the whole BOX, not the bounding box of the points:
  // its job is to say how far apart the pins are, which means it has to keep
  // going where there are no pins.
  const halfLatSpan = (height / 2) * unitsPerPx;
  const halfLngSpan = ((width / 2) * unitsPerPx) / lngScale;
  const latStep = graticuleStep(halfLatSpan * 2);
  const lngStep = graticuleStep(halfLngSpan * 2);
  const parallels: GraticuleLine[] = [];
  const firstParallel =
    Math.ceil((centreLat - halfLatSpan) / latStep) * latStep;
  for (
    let degrees = firstParallel;
    degrees <= centreLat + halfLatSpan;
    degrees += latStep
  ) {
    parallels.push({ at: project(degrees, centreLng).y, degrees });
  }
  const meridians: GraticuleLine[] = [];
  const firstMeridian =
    Math.ceil((centreLng - halfLngSpan) / lngStep) * lngStep;
  for (
    let degrees = firstMeridian;
    degrees <= centreLng + halfLngSpan;
    degrees += lngStep
  ) {
    meridians.push({ at: project(centreLat, degrees).x, degrees });
  }

  // A bar somewhere under a third of the width, rounded down to a number worth
  // printing. Rounding DOWN matters: a bar rounded up would run past the width
  // it was measured against.
  const kmPerPx = unitsPerPx * KM_PER_DEG_LAT;
  const km = niceDistance(clamp(boxWidth * 0.3, 1, boxWidth) * kmPerPx);
  return {
    pins,
    meridians,
    parallels,
    scale: { px: km / kmPerPx, km },
    width,
    height,
  };
}

/**
 * The name to PRINT for a place, or null when there is nothing worth printing.
 *
 * A place whose name is still its own coordinate — which is every place until
 * a gazetteer is installed, see docs/photos-places.md — has a name in the
 * database and no name a person would recognise. Printing "37.4419, -122.1430"
 * beside a pin is worse than printing nothing: it looks like an answer.
 *
 * This is the display-side twin of `isCoordinateLabel` in the vault's
 * media.ts, deliberately duplicated rather than imported — a blueprint runs in
 * the app sandbox and does not link the vault package, and the shape being
 * matched is a four-line regex, not a shared rule that could drift into
 * meaning two different things.
 */
export function readableName(name: string | null | undefined): string | null {
  const text = (name ?? "").trim();
  if (text === "") return null;
  return /^-?\d{1,3}\.\d+,\s*-?\d{1,3}\.\d+$/u.test(text) ? null : text;
}
