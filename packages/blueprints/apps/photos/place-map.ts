export interface PlacePoint {
  key: string;
  lat: number;
  lng: number;
  count: number;
  name: string | null;
  thumb?: string | null;
}

export interface MapPin {
  key: string;
  x: number;
  y: number;
  count: number;
  name: string | null;
  places: number;
  thumb?: string | null;
}

export interface GraticuleLine {
  at: number;
  degrees: number;
}

export interface MapScale {
  px: number;
  km: number;
}

export interface MapCamera {
  lat: number;
  lng: number;
  kmPerPx: number;
}

export type MapTier = "countries" | "cities" | "spots";

export interface MapProjection {
  pins: MapPin[];
  meridians: GraticuleLine[];
  parallels: GraticuleLine[];
  scale: MapScale;
  camera: MapCamera;
  tier: MapTier;
  width: number;
  height: number;
}

export interface ProjectOptions {
  width: number;
  height: number;
  padding?: number;
  mergeDistance?: number;
  camera?: MapCamera;
}

const KM_PER_DEG_LAT = 111.32;

const MIN_SPAN_DEG = 0.01;

const MIN_KM_PER_PX = 1e-6;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

const TIER_CEILING_KM_PER_PX = { countries: 0.5, cities: 0.02 };

const TIER_FLOOR_KM: Record<MapTier, number> = {
  countries: 25,
  cities: 1,
  spots: 0.05,
};

export function mapTier(kmPerPx: number): MapTier {
  if (kmPerPx >= TIER_CEILING_KM_PER_PX.countries) return "countries";
  if (kmPerPx >= TIER_CEILING_KM_PER_PX.cities) return "cities";
  return "spots";
}

export function tierNoun(tier: MapTier): string {
  return tier === "countries"
    ? "Countries"
    : tier === "cities"
      ? "Cities"
      : "Spots";
}

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

function lngScaleAt(centreLat: number): number {
  return Math.max(0.05, Math.cos((centreLat * Math.PI) / 180));
}

export function graticuleStep(spanDeg: number): number {
  const rough = spanDeg / 4;
  const power = 10 ** Math.floor(Math.log10(Math.max(rough, 1e-6)));
  const scaled = rough / power;
  const nice = scaled >= 5 ? 5 : scaled >= 2 ? 2 : 1;
  return nice * power;
}

function niceDistance(km: number): number {
  const power = 10 ** Math.floor(Math.log10(Math.max(km, 1e-6)));
  const scaled = km / power;
  const nice = scaled >= 5 ? 5 : scaled >= 2 ? 2 : 1;
  return nice * power;
}

export function kmPerPxForSpan(
  latitudeDegrees: number,
  heightPx: number
): number {
  return (Math.abs(latitudeDegrees) * KM_PER_DEG_LAT) / Math.max(1, heightPx);
}

export function tileZoomFor(camera: MapCamera): number {
  const metresPerPx = Math.max(camera.kmPerPx, MIN_KM_PER_PX) * 1000;
  const equatorial = 156_543.033_92 * lngScaleAt(camera.lat);
  return clamp(Math.log2(equatorial / metresPerPx), 0, 20);
}

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
    y: box.height / 2 - (lat - camera.lat) / unitsPerPx,
  };
}

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

  const latSpan = Math.max(Math.max(...lats) - Math.min(...lats), MIN_SPAN_DEG);
  const lngSpan = Math.max(
    (Math.max(...lngs) - Math.min(...lngs)) * lngScale,
    MIN_SPAN_DEG * lngScale
  );

  const unitsPerPx = Math.max(latSpan / boxHeight, lngSpan / boxWidth);
  return {
    lat: centreLat,
    lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
    kmPerPx: unitsPerPx * KM_PER_DEG_LAT,
  };
}

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

export function readableName(name: string | null | undefined): string | null {
  const text = (name ?? "").trim();
  if (text === "") return null;
  return /^-?\d{1,3}\.\d+,\s*-?\d{1,3}\.\d+$/u.test(text) ? null : text;
}
