// Display layer over the vault's trip detection (#816); what a trip IS belongs
// to `enrich/memories.ts`. Titles use phrase rungs 1-2 only, unhedged — rung 3
// is relative to home. Import-free, so small helpers are duplicated here.

export interface TripPlace {
  key: string;
  name?: string | null;
  gazetteer?: string | null;
  lat?: number | null;
  lng?: number | null;
}

export interface TripMember {
  capturedAt?: string | null;
  tzOffsetMin?: number | null;
  /** Nullable: an unplaced frame still counts, and is never "at home". */
  place?: TripPlace | null;
}

// Must stay assignable to `place-map.ts`'s `PlacePoint`.
export interface TripRoutePoint {
  key: string;
  lat: number;
  lng: number;
  count: number;
  name: string | null;
}

export interface TripFacts {
  title: string | null;
  placeName: string | null;
  awayDays: number;
  includesWeekend: boolean;
  route: TripRoutePoint[];
}

export interface TripFactsInput {
  members: readonly TripMember[];
  /** Only COUNTS days; never decides what a trip is. Null = no home known. */
  homePlaceKey?: string | null;
  /** `title_hint`: authoritative day count, and the fallback title. */
  titleHint?: string | null;
  /** `place_id`: card and projection must name the same place. */
  placeKey?: string | null;
}

// DISPLAY grammar, tunable; not what a trip IS.
const WEEKEND_MIN_DAYS = 2;
const WEEKEND_MAX_DAYS = 3;

const WEEK_MIN_DAYS = 6;
const WEEK_MAX_DAYS = 8;

function isCoordinateLabel(text: string): boolean {
  return /^-?\d{1,3}\.\d+,\s*-?\d{1,3}\.\d+$/u.test(text);
}

function printableName(name: string | null | undefined): string | null {
  const text = (name ?? "").trim();
  if (text === "") return null;
  return isCoordinateLabel(text) ? null : text;
}

export function tripPlaceName(
  place: TripPlace | null | undefined
): string | null {
  if (!place) return null;
  return printableName(place.name) ?? printableName(place.gazetteer);
}

// Must stay the vault's `captureLocalDay` rule; the spans are compared.
function captureLocalDay(
  capturedAt: string,
  tzOffsetMin: number | null | undefined
): string | null {
  const at = capturedAt.trim();
  if (at === "") return null;
  if (tzOffsetMin === null || tzOffsetMin === undefined) {
    const raw = at.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/u.test(raw) ? raw : null;
  }
  const shifted = Date.parse(at) + tzOffsetMin * 60_000;
  if (!Number.isFinite(shifted)) return null;
  return new Date(shifted).toISOString().slice(0, 10);
}

// Lowest key breaks a draw, matching the vault's `modalKey`.
function modalKey(counts: ReadonlyMap<string, number>): string | null {
  let best: string | null = null;
  let bestCount = -1;
  for (const key of [...counts.keys()].sort()) {
    const count = counts.get(key)!;
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

// UTC on purpose: the key is already a local day, so a zone would shift twice.
function isWeekendDay(dayKey: string): boolean {
  const day = new Date(`${dayKey}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

function modalPlaceByDay(
  members: readonly TripMember[]
): Map<string, string | null> {
  const votesByDay = new Map<string, Map<string, number>>();
  const days = new Set<string>();
  for (const member of members) {
    if (member.capturedAt == null) continue;
    const day = captureLocalDay(member.capturedAt, member.tzOffsetMin);
    if (day === null) continue;
    days.add(day);
    const key = member.place?.key;
    if (key == null || key === "") continue;
    const votes = votesByDay.get(day) ?? new Map<string, number>();
    votes.set(key, (votes.get(key) ?? 0) + 1);
    votesByDay.set(day, votes);
  }
  const modal = new Map<string, string | null>();
  for (const day of [...days].sort()) {
    const votes = votesByDay.get(day);
    modal.set(day, votes ? modalKey(votes) : null);
  }
  return modal;
}

// A day with no placed frame is NOT away — the vault bridged it.
export function awayDaysOf(
  members: readonly TripMember[],
  homePlaceKey?: string | null
): string[] {
  const away: string[] = [];
  for (const [day, placeKey] of modalPlaceByDay(members)) {
    if (placeKey === null) continue;
    if (homePlaceKey != null && placeKey === homePlaceKey) continue;
    away.push(day);
  }
  return away;
}

export function hintDayCount(
  titleHint: string | null | undefined
): number | null {
  const match = /^(?<days>\d+)-day trip$/u.exec((titleHint ?? "").trim());
  if (!match) return null;
  const days = Number(match.groups?.days);
  return Number.isInteger(days) && days > 0 ? days : null;
}

// Pass the WHOLE library: a trip's modal place is where they travelled to.
export function resolveHomeKey(
  members: readonly TripMember[],
  homeTaggedKeys: readonly string[] = []
): string | null {
  const tagged = [...homeTaggedKeys].filter((key) => key !== "").sort()[0];
  if (tagged !== undefined) return tagged;
  const counts = new Map<string, number>();
  for (const member of members) {
    const key = member.place?.key;
    if (key == null || key === "") continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return modalKey(counts);
}

// Capture order, not size order: a line ordered by popularity is not a route.
export function tripRoute(members: readonly TripMember[]): TripRoutePoint[] {
  const order: string[] = [];
  const byKey = new Map<string, TripRoutePoint>();
  const dated = members.filter((member) => member.capturedAt != null);
  const undated = members.filter((member) => member.capturedAt == null);
  const sorted = [
    ...[...dated].sort((a, b) =>
      String(a.capturedAt).localeCompare(String(b.capturedAt))
    ),
    ...undated,
  ];
  for (const member of sorted) {
    const place = member.place;
    if (!place || place.key === "") continue;
    const lat = place.lat;
    const lng = place.lng;
    if (lat == null || lng == null) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const existing = byKey.get(place.key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    order.push(place.key);
    byKey.set(place.key, {
      key: place.key,
      lat,
      lng,
      count: 1,
      name: tripPlaceName(place),
    });
  }
  return order.map((key) => byKey.get(key)!);
}

function plainDays(days: number): string {
  return `${days} day${days === 1 ? "" : "s"}`;
}

// The title is never coordinate-shaped and never relative to home, ever.
export function tripFacts({
  members,
  homePlaceKey = null,
  titleHint = null,
  placeKey = null,
}: TripFactsInput): TripFacts {
  const awayDays = awayDaysOf(members, homePlaceKey);
  const days = hintDayCount(titleHint) ?? awayDays.length;
  const includesWeekend = awayDays.some((day) => isWeekendDay(day));
  const route = tripRoute(members);

  const awayPlaces = new Map<string, { place: TripPlace; count: number }>();
  for (const member of members) {
    const place = member.place;
    if (!place || place.key === "") continue;
    if (homePlaceKey != null && place.key === homePlaceKey) continue;
    const existing = awayPlaces.get(place.key);
    if (existing) existing.count += 1;
    else awayPlaces.set(place.key, { place, count: 1 });
  }
  const ranked = [...awayPlaces.values()].sort(
    (a, b) => b.count - a.count || a.place.key.localeCompare(b.place.key)
  );
  const preferred = placeKey == null ? undefined : awayPlaces.get(placeKey);
  const candidates = preferred ? [preferred, ...ranked] : ranked;
  let placeName: string | null = null;
  for (const candidate of candidates) {
    const name = tripPlaceName(candidate.place);
    if (name !== null) {
      placeName = name;
      break;
    }
  }

  if (days <= 0) {
    return {
      title: printableName(titleHint),
      placeName,
      awayDays: awayDays.length,
      includesWeekend,
      route,
    };
  }
  if (placeName === null) {
    return {
      title: printableName(titleHint) ?? `${days}-day trip`,
      placeName,
      awayDays: awayDays.length,
      includesWeekend,
      route,
    };
  }
  const span =
    days >= WEEKEND_MIN_DAYS && days <= WEEKEND_MAX_DAYS && includesWeekend
      ? "Weekend"
      : days >= WEEK_MIN_DAYS && days <= WEEK_MAX_DAYS
        ? "A week"
        : plainDays(days);
  return {
    title: `${span} in ${placeName}`,
    placeName,
    awayDays: awayDays.length,
    includesWeekend,
    route,
  };
}
