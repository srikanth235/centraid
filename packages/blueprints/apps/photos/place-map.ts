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

/**
 * WHERE THE EYE IS, in the only two numbers a projection needs: a centre and
 * how much ground one pixel covers.
 *
 * The sketch derives this from the points (`fitCamera`) because a drawing that
 * fits its own data is the whole idea of a figure. A real basemap derives it
 * from the member's fingers instead — they pinch, the map reports a new
 * visible span, and the same arithmetic runs again. Stating the camera as a
 * value rather than hiding it inside the fit is what lets both happen without
 * two projections.
 */
export interface MapCamera {
  lat: number;
  lng: number;
  /** Kilometres of ground per pixel of the drawing. */
  kmPerPx: number;
}

/**
 * WHAT A PIN STANDS FOR at the scale currently drawn.
 *
 * A map that groups by pixels alone is honest about the DRAWING and says
 * nothing about the ground: zoomed far enough in, two rows the place ledger
 * cannot tell apart (identity is rounded to ~11m) would fly apart into a
 * scatter of pins claiming a precision nothing in the vault has. So the merge
 * carries a floor in GROUND units, and the floor is chosen by the scale — a
 * pin is a region, a town, or somewhere you can walk to.
 *
 * Both surfaces read this from the same function, so "the phone and the
 * browser group the same way at the same scale" is arithmetic rather than a
 * convention two files are supposed to keep.
 */
export type MapTier = "countries" | "cities" | "spots";

export interface MapProjection {
  pins: MapPin[];
  /** Meridians — vertical lines, `at` is an x. */
  meridians: GraticuleLine[];
  /** Parallels — horizontal lines, `at` is a y. */
  parallels: GraticuleLine[];
  scale: MapScale;
  /** The camera these pins were drawn through — fitted, or the one passed. */
  camera: MapCamera;
  /** What a pin stands for at this camera's scale. */
  tier: MapTier;
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
  /**
   * Draw through THIS camera instead of fitting one to the points. A basemap
   * owns its own viewport — the member moved it — and the pins have to land
   * where the ground under them is, not where a fit would have put them.
   */
  camera?: MapCamera;
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

/**
 * The finest a camera is allowed to claim: a millimetre of ground per pixel.
 *
 * Only a guard against a division by zero — a caller handing over a camera it
 * has not measured yet (a basemap reports its viewport one frame after mount)
 * would otherwise put every pin at infinity.
 */
const MIN_KM_PER_PX = 1e-6;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

/**
 * The ladder, in kilometres of ground per pixel.
 *
 * Read off the drawing rather than off a zoom integer, because the two map
 * SDKs under this do not agree on what "zoom 12" means and a pixel is the one
 * unit both of them and the sketch share. The boundaries are stated as what a
 * 400px-wide map covers: 200km and up is countries, down to 8km is cities,
 * and under that is spots.
 */
const TIER_CEILING_KM_PER_PX = { countries: 0.5, cities: 0.02 };

/**
 * How far apart two places must be, ON THE GROUND, to still be two pins at
 * each tier. Below the floor the map would be splitting hairs the ledger
 * cannot: place identity is rounded to ~11m, so 50m is the tightest split
 * that still means something.
 */
const TIER_FLOOR_KM: Record<MapTier, number> = {
  countries: 25,
  cities: 1,
  spots: 0.05,
};

/** Which tier a camera at this scale is looking at. */
export function mapTier(kmPerPx: number): MapTier {
  if (kmPerPx >= TIER_CEILING_KM_PER_PX.countries) return "countries";
  if (kmPerPx >= TIER_CEILING_KM_PER_PX.cities) return "cities";
  return "spots";
}

/** The noun for a tier, for a legend beside the scale bar. Both surfaces print
 *  this one, so neither can invent its own vocabulary for the same scale. */
export function tierNoun(tier: MapTier): string {
  return tier === "countries"
    ? "Countries"
    : tier === "cities"
      ? "Cities"
      : "Spots";
}

/**
 * The merge threshold actually used: the larger of "two pins would overlap"
 * (a fact about the drawing, which the caller measures in its own pin width)
 * and "the tier says these are one place" (a fact about the ground).
 *
 * The two swap over as a member zooms. At trip scale the pins are enormous
 * next to a 25km floor and the drawing decides; at street scale 50m is wider
 * than any pin and the ground decides.
 */
export function tierMergeDistance(
  tier: MapTier,
  kmPerPx: number,
  pinDistance: number
): number {
  return Math.max(
    pinDistance,
    TIER_FLOOR_KM[tier] / Math.max(kmPerPx, MIN_KM_PER_PX)
  );
}

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
 * Ground per pixel, from the slice of latitude a viewport is showing.
 *
 * Both map SDKs report their viewport this way — MapKit as a `latitudeDelta`,
 * MapLibre as bounds — and neither reports it in a unit the other would
 * recognise. Latitude is the one axis whose degrees are the same length
 * everywhere, so converting through it is what lets one camera type describe
 * both, and therefore what lets one merge rule run on both.
 */
export function kmPerPxForSpan(
  latitudeDegrees: number,
  heightPx: number
): number {
  return (Math.abs(latitudeDegrees) * KM_PER_DEG_LAT) / Math.max(1, heightPx);
}

/**
 * The tile-pyramid zoom that shows this much ground per pixel.
 *
 * Needed only to hand a basemap its OPENING viewport — a member who opens
 * Places should be looking at their own photographs rather than at whatever
 * the SDK's default centre is. It is the standard 256px-tile relation
 * (156543.03m per pixel at the equator at zoom 0, scaled by the cosine), which
 * both SDKs implement; the pins themselves are never placed through it, so the
 * sub-pixel disagreement between this and `projectAt`'s flat projection at
 * trip scale never reaches the drawing.
 */
export function tileZoomFor(camera: MapCamera): number {
  const metresPerPx = Math.max(camera.kmPerPx, MIN_KM_PER_PX) * 1000;
  const equatorial = 156_543.033_92 * lngScaleAt(camera.lat);
  return clamp(Math.log2(equatorial / metresPerPx), 0, 20);
}

/**
 * A pixel position for one coordinate, seen through a camera.
 *
 * Exported because a basemap has to run this BACKWARDS as well: the SDK hands
 * over the coordinate a member tapped, and the only way to find out which pin
 * that was is to project it into the same pixel space the pins live in. See
 * `pinAtPoint`.
 */
export function projectAt(
  camera: MapCamera,
  box: { width: number; height: number },
  lat: number,
  lng: number
): { x: number; y: number } {
  const unitsPerPx = Math.max(camera.kmPerPx, MIN_KM_PER_PX) / KM_PER_DEG_LAT;
  const lngScale = lngScaleAt(camera.lat);
  return {
    x: box.width / 2 + ((lng - camera.lng) * lngScale) / unitsPerPx,
    // Latitude grows northward and y grows downward, hence the negation. This
    // is the one sign error that produces a map which looks plausible and is
    // upside down, so it gets a sentence of its own.
    y: box.height / 2 - (lat - camera.lat) / unitsPerPx,
  };
}

/**
 * The coordinate at a pixel — `projectAt` run backwards.
 *
 * A basemap anchors its markers to the GROUND rather than to a box, because a
 * marker has to hold still under a member's finger while the map moves. The
 * pins carry a position in the drawing, so this is how a provider asks where
 * that position actually is. Exact rather than approximate: the forward
 * projection is one multiply per axis, so the inverse is too.
 */
export function coordAt(
  camera: MapCamera,
  box: { width: number; height: number },
  x: number,
  y: number
): { lat: number; lng: number } {
  const unitsPerPx = Math.max(camera.kmPerPx, MIN_KM_PER_PX) / KM_PER_DEG_LAT;
  const lngScale = lngScaleAt(camera.lat);
  return {
    lat: camera.lat + (box.height / 2 - y) * unitsPerPx,
    lng: camera.lng + ((x - box.width / 2) * unitsPerPx) / lngScale,
  };
}

/**
 * The pin under a point, or null when the tap landed on the map itself.
 *
 * This is the phone's whole hit test. `expo-maps` only fires its marker-press
 * events on iOS 18 and the app's deployment target is 17.5, so a pin tap
 * cannot be delegated to the SDK without silently dropping every tap on iOS
 * 17. Asking the projection instead costs one loop over at most a screenful
 * of pins and behaves identically on both platforms — which is the same
 * argument that put the merge in this file.
 *
 * Nearest-wins rather than first-wins: two pins whose targets overlap should
 * open the one whose centre the finger was closest to.
 */
export function pinAtPoint(
  pins: readonly MapPin[],
  x: number,
  y: number,
  radius: number
): MapPin | null {
  let best: MapPin | null = null;
  let bestDistance = radius;
  for (const pin of pins) {
    const distance = Math.hypot(pin.x - x, pin.y - y);
    if (distance <= bestDistance) {
      best = pin;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The camera a drawing of these points would choose for itself, or null when
 * there is nothing to look at.
 *
 * The sketch's own viewport, and also the opening viewport a basemap is
 * handed — a member who opens Places should be looking at their own
 * photographs, not at whatever the SDK's default centre is.
 */
export function fitCamera(
  points: readonly PlacePoint[],
  { width, height, padding = 18 }: ProjectOptions
): MapCamera | null {
  const usable = points.filter(
    (point) => Number.isFinite(point.lat) && Number.isFinite(point.lng)
  );
  if (usable.length === 0) return null;
  const boxWidth = Math.max(1, width - padding * 2);
  const boxHeight = Math.max(1, height - padding * 2);
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
  return {
    lat: centreLat,
    lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
    kmPerPx: unitsPerPx * KM_PER_DEG_LAT,
  };
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
  options: ProjectOptions
): MapProjection {
  const { width, height, mergeDistance = 20 } = options;
  const usable = points.filter(
    (point) => Number.isFinite(point.lat) && Number.isFinite(point.lng)
  );
  const boxWidth = Math.max(1, width - (options.padding ?? 18) * 2);
  const camera = options.camera ?? fitCamera(points, options);
  if (camera === null || usable.length === 0) {
    return {
      pins: [],
      meridians: [],
      parallels: [],
      scale: { px: 0, km: 0 },
      // A map of nothing is looking at nothing, at no scale. `mapTier` reads
      // that as the tightest rung, which is the honest answer: an empty map
      // makes no claim about how much ground it covers.
      camera: camera ?? { lat: 0, lng: 0, kmPerPx: 0 },
      tier: mapTier(camera?.kmPerPx ?? 0),
      width,
      height,
    };
  }

  const centreLat = camera.lat;
  const centreLng = camera.lng;
  const lngScale = lngScaleAt(centreLat);
  const unitsPerPx = Math.max(camera.kmPerPx, MIN_KM_PER_PX) / KM_PER_DEG_LAT;
  const tier = mapTier(camera.kmPerPx);
  const project = (lat: number, lng: number): { x: number; y: number } =>
    projectAt(camera, { width, height }, lat, lng);

  // Merge by PIXEL distance, not by degrees. Two places 11m apart are two rows
  // in the ledger and one dot on any map wide enough to hold a trip; whether
  // they collide is a question about the drawing, so it is asked in the
  // drawing's units. Points are merged into the largest pin first, so the name
  // that survives a merge is the one with the most photographs behind it
  // rather than whichever happened to be read first.
  //
  // The tier floor is the second half of that sentence (`tierMergeDistance`):
  // the drawing decides while the pins are the wider fact, and the ground
  // decides once a member has zoomed past what the ledger can resolve.
  const merge = tierMergeDistance(tier, camera.kmPerPx, mergeDistance);
  const ordered = [...usable].sort(
    (a, b) => b.count - a.count || a.key.localeCompare(b.key)
  );
  const pins: MapPin[] = [];
  for (const point of ordered) {
    const { x, y } = project(point.lat, point.lng);
    const near = pins.find((pin) => Math.hypot(pin.x - x, pin.y - y) <= merge);
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
    camera,
    tier,
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
