// A TRIP, IN WORDS AND AS A LINE — the display layer over the vault's own trip
// detection (issue #816).
//
// The vault already decides what a trip IS: `packages/vault/src/enrich/
// memories.ts` resolves a home place, finds maximal runs of away capture-days,
// and lands one `media_memory` row per run with the hint `"N-day trip"`. None
// of that is recomputed here and none of it belongs here — a client that
// re-clustered would be a second answer to "was this a trip", and the two would
// drift the first time either threshold moved. This module only takes a trip
// the vault already found and answers two display questions the vault has no
// vocabulary for:
//
//   1. WHAT IS IT CALLED. "3-day trip" is a measurement, not a memory.
//      "Weekend in Truckee, CA" is what a person would say. The name comes off
//      the phrase ladder (`place-phrase.ts`) but only its top two rungs — see
//      WHICH RUNGS below.
//   2. WHAT SHAPE WAS IT. The trip's distinct places in capture order, ready
//      for `projectPlaces` (`place-map.ts`), so a card can carry a small route
//      sketch drawn from arithmetic instead of a basemap nobody may fetch.
//
// WHICH RUNGS, AND WHY NOT ALL FOUR. `placePhrase`'s rung 3 is relative to a
// place the member named — "38 km NE of Home". That is a fine caption under one
// photograph and an unacceptable TITLE: a card title is the most repeated,
// most exported, most screenshot string in the app, and "38 km NE of Home"
// hands anyone reading over a shoulder a bearing and a distance to where the
// member lives. So a title uses rung 1 (a name the member typed) or rung 2 (a
// gazetteer settlement name), and falls back to the vault's own bare hint. A
// coordinate can never appear: `printableName` refuses one, which is the same
// guard `readableName` applies on every other surface.
//
// AND THE GAZETTEER NAME LOSES ITS HEDGE. `placePhrase` prints "near Truckee,
// CA", because a settlement name is a neighbourhood-scale claim about a point.
// A trip is not a point — it is days of days across a region — so the hedge
// that makes the caption honest makes the title wrong: "Weekend in near
// Truckee" is not a sentence. The title says "Weekend in Truckee, CA", which is
// exactly the claim a settlement name supports at trip scale.
//
// WHY IMPORT-FREE. Same reason as `place-map.ts` and `place-phrase.ts`: both
// Photos surfaces title trips — the web strip and the Expo Memories screen —
// and the title must be the same sentence on both or the two products have
// drifted on what they know. Expo bundles this file straight out of the
// blueprints package, so it must not reach into the web app's explicit-`.ts`
// module graph, a stylesheet, or a token. Small helpers are duplicated with a
// comment rather than imported.

/** A place a trip's members were taken at, as the caller already holds it. */
export interface TripPlace {
  /** The `core_place` id. Identity only — never printed. */
  key: string;
  /** The stored name. Coordinate-shaped labels fall through, see the header. */
  name?: string | null;
  /** A settlement name from the opt-in gazetteer automation, when enabled. */
  gazetteer?: string | null;
  lat?: number | null;
  lng?: number | null;
}

/**
 * One member of a trip memory, as thin as the arithmetic needs.
 *
 * `place` is nullable on purpose: the vault's rule makes EVERY dated asset in
 * the trip's date range a member, including frames that carry no place at all
 * (a photograph indoors, an import with no GPS). Those members still count as
 * photographs and must never be dropped or treated as "at home" — they simply
 * contribute no day vote and no route point.
 */
export interface TripMember {
  /** ISO capture time. Absent means the frame has no day to be counted under. */
  capturedAt?: string | null;
  /** Minutes the camera's clock ran ahead of UTC, when it recorded one. */
  tzOffsetMin?: number | null;
  place?: TripPlace | null;
}

/**
 * One stop on the route sketch. Structurally a `PlacePoint` from
 * `place-map.ts` — deliberately restated rather than imported (header), and
 * kept assignable to it so a caller can hand these straight to `projectPlaces`.
 */
export interface TripRoutePoint {
  key: string;
  lat: number;
  lng: number;
  count: number;
  name: string | null;
}

export interface TripFacts {
  /**
   * What the card is titled, or null when even the day count is unknown —
   * a caller with nothing to say falls back to the vault's `title_hint`.
   */
  title: string | null;
  /** The display name the title was built around, null when no rung answered. */
  placeName: string | null;
  /** Distinct away calendar days behind this trip. See `awayDaysOf`. */
  awayDays: number;
  /** True when at least one away day fell on a Saturday or a Sunday. */
  includesWeekend: boolean;
  /** The trip's distinct places, ordered by FIRST capture time. */
  route: TripRoutePoint[];
}

export interface TripFactsInput {
  members: readonly TripMember[];
  /**
   * The member's home place id. Days whose modal place is home are not away
   * days — that is the vault's own rule, applied here only to COUNT the days a
   * title has to be grammatical about, never to decide what a trip is.
   * Omitted (or null) means "no home known", and then every placed day counts.
   */
  homePlaceKey?: string | null;
  /**
   * `media_memory.title_hint` — the vault's `"N-day trip"`. Two jobs: it is the
   * authoritative day count (the vault bridged photo-less days into the run
   * and this module cannot see days with no photographs in them), and it is the
   * fallback title when no place rung answers.
   */
  titleHint?: string | null;
  /**
   * `media_memory.place_id` — the vault's own modal away place. Preferred as
   * the place the title names, because the projection and the card should agree
   * about which place the trip was "in". Falls through to the next-largest away
   * place when this one has no printable name.
   */
  placeKey?: string | null;
}

/**
 * A trip of this many away days or fewer, if it covers a Saturday or a Sunday,
 * is a "Weekend in X".
 *
 * Three rather than two, because a Friday-to-Sunday or Saturday-to-Monday
 * long weekend is what people mean by the word — and the weekend test is what
 * keeps a Tuesday-to-Thursday pair from being called one. The floor is two
 * because one Saturday out is a Saturday, and calling it a weekend claims a day
 * the member did not spend there.
 */
const WEEKEND_MIN_DAYS = 2;
const WEEKEND_MAX_DAYS = 3;

/**
 * The band a trip is called "A week in X" over.
 *
 * Six to eight, not exactly seven: a week away is booked as seven nights and
 * photographed across six days or nine, and "6 days in Kyoto" for what the
 * member calls "our week in Kyoto" is the kind of pedantry a product should
 * not commit. Outside the band the honest numeral reads better than a word.
 *
 * Both thresholds are DISPLAY grammar and safe to tune from evidence; the
 * clustering thresholds that decide what a trip is at all (`TRIP_GAP_DAYS`,
 * `TRIP_MIN_AWAY_DAYS`) live in the vault and are not this module's business.
 */
const WEEK_MIN_DAYS = 6;
const WEEK_MAX_DAYS = 8;

/**
 * Is this "name" just the coordinate wearing a label's clothes?
 *
 * The display-side twin of `isCoordinateLabel` in the vault's media.ts, of
 * `readableName` in `place-map.ts`, and of `place-phrase.ts`'s own copy —
 * duplicated a fourth time rather than imported, because this module links
 * nothing (see the header) and the thing being matched is one regex. Every
 * place minted from GPS carries a name of this shape until somebody renames it.
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

/**
 * The name a TITLE may use for a place: the member's own name, else the
 * gazetteer's settlement name with no "near " hedge (header). Null when neither
 * rung has anything a person would recognise.
 */
export function tripPlaceName(
  place: TripPlace | null | undefined
): string | null {
  if (!place) return null;
  return printableName(place.name) ?? printableName(place.gazetteer);
}

/**
 * The calendar day a frame was captured on.
 *
 * The same rule as the vault's `captureLocalDay` (enrich/memories.ts) —
 * duplicated, not imported, because a blueprint does not link the vault
 * package: shift by the recorded offset when there is one, otherwise slice the
 * instant as given. Matching it matters: these days are compared against the
 * span the vault derived with that rule, and a different rule would count a
 * different number of days for the same trip.
 */
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

/** The most common key, ties broken by the lowest key — the same tie-break the
 *  vault's `modalKey` uses, so both sides pick the same place from a draw. */
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

/** Saturday or Sunday, from a `YYYY-MM-DD` day key. Read in UTC on purpose:
 *  the key is already a local calendar day, so re-applying a zone to it would
 *  shift it a second time. */
function isWeekendDay(dayKey: string): boolean {
  const day = new Date(`${dayKey}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/** The modal place of each of the trip's capture days — the vault's own day
 *  vote, recomputed over the members it handed us so the display can say which
 *  days were away without asking what a trip is. */
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

/**
 * The trip's away calendar days, in order.
 *
 * A day is away when its modal place is not the home place — the vault's rule,
 * read here only for grammar. A day with no placed frame at all is NOT counted
 * as away: an unlocated day inside a trip is a day the vault bridged, and the
 * hint's own count already speaks for it.
 */
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

/** The day count the vault put in its hint, or null when the hint is not one
 *  (`"3-day trip"`). The hint outranks the derived count — see `titleHint`. */
export function hintDayCount(
  titleHint: string | null | undefined
): number | null {
  const match = /^(?<days>\d+)-day trip$/u.exec((titleHint ?? "").trim());
  if (!match) return null;
  const days = Number(match.groups?.days);
  return Number.isInteger(days) && days > 0 ? days : null;
}

/**
 * The member's home place, resolved the way the vault resolves it.
 *
 * The `kind = 'home'` tag when one exists (lowest key on a tie), else the modal
 * place across every placed frame given. Pass the WHOLE library here, not one
 * trip's members: the modal place of a trip is the place the member travelled
 * to, and calling that home would make every away day read as a day at home.
 */
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

/**
 * The trip's distinct places in the order they were first photographed, with
 * how many of the trip's frames each holds.
 *
 * Capture order rather than size order, because the sketch draws a LINE
 * through these and a line through them by popularity is not a route. Places
 * with no usable coordinate drop out (nothing to plot), as do members with no
 * place at all — which is why a trip with one located place still draws a
 * single dot rather than nothing.
 */
export function tripRoute(members: readonly TripMember[]): TripRoutePoint[] {
  const order: string[] = [];
  const byKey = new Map<string, TripRoutePoint>();
  // A member with no capture time has no position in the route's order, so it
  // is counted after every dated one rather than deciding where the line
  // starts. Stable within itself: the caller's own order.
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

/** `2 days` / `1 day` — the numeral rung of the ladder. */
function plainDays(days: number): string {
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * The whole display layer for one trip memory: its title, the place that title
 * names, the day-span facts behind the grammar, and the route to sketch.
 *
 * Pure — same members in, same sentence out, no clock and no locale lookup.
 * The title is never coordinate-shaped and never relative to home for any
 * input; those are the invariants the tests hold and the reason this function
 * exists rather than a template string at each call site.
 */
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

  // Which place the title names: the vault's own modal choice first (so the
  // card and the projection agree), then the away places by how many of the
  // trip's frames they hold. A place the title cannot NAME does not block the
  // rung below it — "3 days in Truckee, CA" beats "3-day trip" even when the
  // busiest place of the three is still an unnamed coordinate.
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
    // No rung answered, so the title stays a measurement — the vault's own
    // hint when it gave one, and the same shape when it did not.
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
