// Memories, as a model (#724, "Memories v0").
//
// NOT THE CLIENT-SIDE SHELF. `photos-collections.ts`'s "Memories" is an
// honest explainer over ONE kind, computed from whatever is currently loaded
// in the timeline (`timeline-model.ts#onThisDay`): today's month-day, filtered
// to years strictly before this one. It can only ever know about the day the
// app happens to be open on, and it has no notion of "Trips" or "Similar
// moments" at all, because those need signals (place history, phash/burst
// grouping) the timeline's loaded window does not carry consistently.
//
// This module reads the REAL projection instead:
// `packages/vault/src/enrich/memories.ts`'s standing sweep, which lands rows
// in `media.memory` / `media.memory_member` and reaches this phone through
// the same replica read path every other Photos shelf uses
// (`useReplicaQuery`, see `MemoriesView.tsx`). Nothing here computes a
// memory — every function below only GROUPS AND FILTERS rows the vault
// already derived, exactly like `photos-collections.ts` does for albums and
// places over their own replica rows.
//
// HONEST EMPTY STATES (the law this file exists to keep). A member should
// never see a shelf claiming to hold something it does not:
//
//   - `buildOnThisDayMemory` returns `null` — not an empty group — unless
//     TODAY'S month-day has a `media.memory` row AND that row still has at
//     least one member from a year strictly before this one once today's
//     own photographs (if the member already shot something today) are
//     excluded. A memory of "this exact day, this exact year" is not a
//     memory of anything.
//   - `buildTripMemories` / `buildSimilarMemories` drop any memory row whose
//     members do not resolve against the assets this phone actually has
//     loaded (deleted, or not yet synced) — a shelf with a memory_id and no
//     visible photographs is not a shelf.
//
// This module is deliberately free of `react-native` and replica imports —
// pure functions over already-fetched rows, so `memories-model.test.ts` can
// assert every rule directly (the same posture `photos-collections.ts` and
// `duplicate-clusters.ts` both take).

// WHAT A TRIP IS CALLED is not decided here either (#816). The vault's
// hint is `"3-day trip"`, a measurement; the phrase ladder in
// `@centraid/blueprints/apps/photos/trips` turns it into "Weekend in South Lake
// Tahoe, CA" and hands back the route to sketch. Deep subpath, the established
// pattern for shared Photos arithmetic (see `places-model.ts`): the phone and
// the web strip run the SAME title function, so a trip cannot be called two
// different things on two of the member's own screens.
import { gazetteerNameFrom } from "@centraid/blueprints/apps/photos/place-phrase";
import {
  resolveHomeKey,
  tripFacts,
} from "@centraid/blueprints/apps/photos/trips";
import type {
  TripMember,
  TripPlace,
  TripRoutePoint,
} from "@centraid/blueprints/apps/photos/trips";

import type { PhotoAsset } from "./timeline-model";

/** One year's worth of on-this-day photographs, newest year first among the
 *  group's own `years` array. */
export interface MemoryYearGroup {
  year: string;
  assets: PhotoAsset[];
}

export interface OnThisDayMemory {
  memoryId: string;
  /** Newest year first — mirrors `photos-collections.ts#memoriesByYear`. */
  years: MemoryYearGroup[];
}

export interface TripMemory {
  memoryId: string;
  placeId: string | null;
  /**
   * The place the title names, or null when no place the trip visited has a
   * name worth printing. Read from the places its own MEMBERS were photographed
   * at (#816) rather than looked up from the row's `place_id` alone: a
   * coordinate-shaped label is not a name, and the gazetteer's settlement name
   * is the rung below it. Still no I/O — the caller passes the rows in.
   */
  placeName: string | null;
  /** e.g. "3-day trip" — straight off `media_memory.title_hint`. */
  titleHint: string | null;
  /**
   * What the block is HEADED (#816): the phrase ladder's answer over the
   * trip's own members — "Weekend in South Lake Tahoe, CA" — falling back to
   * the vault's bare hint when no place the trip visited has a name worth
   * printing. Never a coordinate and never relative to home; see `trips.ts`.
   */
  title: string;
  /** The trip's stops in capture order, for the route sketch. Empty when no
   *  member carried a usable coordinate. */
  route: TripRoutePoint[];
  startedAt: string | null;
  endedAt: string | null;
  assets: PhotoAsset[];
}

export interface SimilarMemory {
  memoryId: string;
  assets: PhotoAsset[];
}

export interface MemoriesModel {
  onThisDay: OnThisDayMemory | null;
  trips: readonly TripMemory[];
  similar: readonly SimilarMemory[];
}

/** A raw `media.memory` row, exactly as `useReplicaQuery` hands it back —
 *  string-keyed, values not yet cast. */
export type RawMemoryRow = Readonly<Record<string, unknown>>;
export type RawMemoryMemberRow = Readonly<Record<string, unknown>>;
export type RawPlaceRow = Readonly<Record<string, unknown>>;

/** A place a trip visited, plus whether it is the one the member calls home. */
export interface MemoryPlace extends TripPlace {
  isHome?: boolean;
}

/**
 * A coordinate is a NUMBER column or it is nothing — the same guard
 * `places-model.ts` applies, and for the same reason: an explicit NULL, a
 * string, or any other type is dropped by type rather than coerced and caught
 * as NaN inside the projection.
 */
function coordOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The place facts a trip's title and route need, keyed by `place_id`.
 *
 * Column contract (#787): `core_place` ships `geo_lat`/`geo_lng`
 * (packages/vault/src/schema/core.ts) and the phone reads replica rows RAW —
 * only the web handler renames them — so the physical columns are read first
 * with `latitude`/`lat` kept as fixture fallbacks, the same chain
 * `places-model.ts#placePoints` reads. The gazetteer name is dug out of
 * `address_json` by the shared reader, so the phone and the web see rung 2 of
 * the ladder identically or not at all.
 */
export function memoryPlacesById(
  rows: readonly RawPlaceRow[]
): Map<string, MemoryPlace> {
  const byId = new Map<string, MemoryPlace>();
  for (const row of rows) {
    const key = String(row.place_id ?? "");
    if (key === "") continue;
    byId.set(key, {
      key,
      name: row.name == null ? null : String(row.name),
      gazetteer: gazetteerNameFrom(
        row.address_json == null ? null : String(row.address_json)
      ),
      lat: coordOf(row.geo_lat ?? row.latitude ?? row.lat),
      lng: coordOf(row.geo_lng ?? row.longitude ?? row.lng),
      isHome: row.kind === "home",
    });
  }
  return byId;
}

/** One asset as `trips.ts` wants a trip member: when, in whose zone, where. */
function tripMemberOf(
  asset: PhotoAsset,
  places: ReadonlyMap<string, MemoryPlace>
): TripMember {
  return {
    capturedAt: asset.capturedAt ?? null,
    tzOffsetMin: asset.tzOffsetMin ?? null,
    place: asset.placeId ? (places.get(asset.placeId) ?? null) : null,
  };
}

/**
 * The member's home place, resolved over the WHOLE loaded library.
 *
 * Not over one trip's members: the modal place of a trip is where the member
 * went, and calling that home would read every away day as a day at home. The
 * `kind = 'home'` tag wins when a row carries one, which is the vault's own
 * rule (`resolveHomePlace` in enrich/memories.ts).
 */
export function homePlaceKey(
  assets: readonly PhotoAsset[],
  places: ReadonlyMap<string, MemoryPlace>
): string | null {
  const tagged = [...places.values()]
    .filter((place) => place.isHome === true)
    .map((place) => place.key);
  return resolveHomeKey(
    assets.map((asset) => tripMemberOf(asset, places)),
    tagged
  );
}

function textOf(row: RawMemoryRow, column: string): string | null {
  const value = row[column];
  return value === null || value === undefined ? null : String(value);
}

/**
 * Every asset reachable by BOTH ids it answers to — `id` (the timeline row's
 * own key) and `assetId` (`media_asset.asset_id`, what
 * `media_memory_member.asset_id` actually points at) — mirroring
 * `PhotosCollectionsView.tsx`'s `byId` map exactly, because a memory member
 * is looked up the same way an album entry is.
 */
export function indexAssetsById(
  assets: readonly PhotoAsset[]
): Map<string, PhotoAsset> {
  const byId = new Map<string, PhotoAsset>();
  for (const asset of assets) {
    byId.set(asset.id, asset);
    if (asset.assetId) byId.set(asset.assetId, asset);
  }
  return byId;
}

/** `memory_id -> ordered asset_ids`, ordinal-sorted once rather than
 *  per-lookup. */
function memberIdsByMemory(
  rawMembers: readonly RawMemoryMemberRow[]
): Map<string, string[]> {
  const sorted = [...rawMembers].sort(
    (a, b) => Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0)
  );
  const byMemory = new Map<string, string[]>();
  for (const member of sorted) {
    const memoryId = String(member.memory_id);
    const list = byMemory.get(memoryId);
    if (list) list.push(String(member.asset_id));
    else byMemory.set(memoryId, [String(member.asset_id)]);
  }
  return byMemory;
}

/** Member ids resolved against the phone's own loaded assets — deleted or
 *  unresolvable ids drop out silently (honest empty states, module header). */
function resolveMembers(
  assetIds: readonly string[] | undefined,
  assetsById: ReadonlyMap<string, PhotoAsset>
): PhotoAsset[] {
  if (!assetIds) return [];
  return assetIds.flatMap((id) => {
    const asset = assetsById.get(id);
    return asset && !asset.deleted ? [asset] : [];
  });
}

/**
 * `'MM-DD'` for `now`, in the viewing device's own calendar — the same
 * reference `timeline-model.ts#onThisDay` uses, so the two never disagree
 * about which day is "today".
 */
function todayKey(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${month}-${day}`;
}

/**
 * On-this-day, narrowed to TODAY from the year-agnostic projection (module
 * header: the vault groups by month-day only, so this is where "today" gets
 * applied). `null` — not an empty `years` list — when there is no row for
 * today's month-day, or every member left after excluding this exact
 * calendar year turns out empty.
 */
export function buildOnThisDayMemory(
  rawMemories: readonly RawMemoryRow[],
  rawMembers: readonly RawMemoryMemberRow[],
  assetsById: ReadonlyMap<string, PhotoAsset>,
  now: Date
): OnThisDayMemory | null {
  const key = todayKey(now);
  const row = rawMemories.find(
    (candidate) =>
      textOf(candidate, "kind") === "on-this-day" &&
      textOf(candidate, "day_key") === key
  );
  if (!row) return null;
  const memoryId = String(row.memory_id);
  const members = resolveMembers(
    memberIdsByMemory(rawMembers).get(memoryId),
    assetsById
  );
  const currentYear = now.getFullYear();
  const byYear = new Map<string, PhotoAsset[]>();
  for (const asset of members) {
    // Honest absence carried through from the sweep (no captured_at, no
    // day) — belt and braces, since the vault projection already excludes
    // undated assets from 'on-this-day' rows entirely.
    if (asset.capturedAt === undefined) continue;
    const year = asset.capturedAt.slice(0, 4);
    // This exact calendar year is "today", not a memory of it.
    if (Number(year) >= currentYear) continue;
    const list = byYear.get(year);
    if (list) list.push(asset);
    else byYear.set(year, [asset]);
  }
  if (byYear.size === 0) return null;
  const years = [...byYear.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([year, assets]) => ({ year, assets }));
  return { memoryId, years };
}

/**
 * Every 'trip' memory with at least one resolvable, live member — newest
 * trip first. `places` carries the place facts the title and the route are
 * built from; a trip whose place is not (yet) in the caller's own place rows
 * still renders, titled by the vault's hint, rather than being dropped, since
 * the photographs themselves are the point of the shelf.
 *
 * `homeKey` is the member's home place (`homePlaceKey` over the whole library),
 * used only to keep home out of the title and out of the away-day count.
 */
export function buildTripMemories(
  rawMemories: readonly RawMemoryRow[],
  rawMembers: readonly RawMemoryMemberRow[],
  assetsById: ReadonlyMap<string, PhotoAsset>,
  places: ReadonlyMap<string, MemoryPlace>,
  homeKey: string | null = null
): TripMemory[] {
  const membersByMemory = memberIdsByMemory(rawMembers);
  const trips: TripMemory[] = [];
  for (const row of rawMemories) {
    if (textOf(row, "kind") !== "trip") continue;
    const memoryId = String(row.memory_id);
    const assets = resolveMembers(membersByMemory.get(memoryId), assetsById);
    if (assets.length === 0) continue;
    const placeId = textOf(row, "place_id");
    const titleHint = textOf(row, "title_hint");
    const facts = tripFacts({
      members: assets.map((asset) => tripMemberOf(asset, places)),
      homePlaceKey: homeKey,
      titleHint,
      placeKey: placeId,
    });
    trips.push({
      memoryId,
      placeId,
      placeName: facts.placeName,
      titleHint,
      // "Away from home" is the last resort it always was: a trip with neither
      // a named place nor a day count has nothing truer to say.
      title: facts.title ?? "Away from home",
      route: facts.route,
      startedAt: textOf(row, "started_at"),
      endedAt: textOf(row, "ended_at"),
      assets,
    });
  }
  return trips.sort((a, b) =>
    (b.startedAt ?? "").localeCompare(a.startedAt ?? "")
  );
}

/**
 * Every 'similar' memory with at least one resolvable, live member. Order is
 * the group's OWN lowest `memory_id` (`similar:<lowest asset_id>`,
 * `memories.ts`), which is already a stable, arbitrary-but-consistent order —
 * good enough for a rail that has no natural chronology of its own the way
 * trips (by date) or on-this-day (by year) do.
 */
export function buildSimilarMemories(
  rawMemories: readonly RawMemoryRow[],
  rawMembers: readonly RawMemoryMemberRow[],
  assetsById: ReadonlyMap<string, PhotoAsset>
): SimilarMemory[] {
  const membersByMemory = memberIdsByMemory(rawMembers);
  const groups: SimilarMemory[] = [];
  for (const row of rawMemories) {
    if (textOf(row, "kind") !== "similar") continue;
    const memoryId = String(row.memory_id);
    const assets = resolveMembers(membersByMemory.get(memoryId), assetsById);
    if (assets.length === 0) continue;
    groups.push({ memoryId, assets });
  }
  return groups.sort((a, b) => a.memoryId.localeCompare(b.memoryId));
}

/** Every section, built once from the same raw rows. */
export function buildMemoriesModel(
  rawMemories: readonly RawMemoryRow[],
  rawMembers: readonly RawMemoryMemberRow[],
  assets: readonly PhotoAsset[],
  places: ReadonlyMap<string, MemoryPlace>,
  now: Date
): MemoriesModel {
  const assetsById = indexAssetsById(assets);
  // Resolved once over the whole library, then handed down — see
  // `homePlaceKey` for why a trip's own members are the wrong evidence.
  const homeKey = homePlaceKey(assets, places);
  return {
    onThisDay: buildOnThisDayMemory(rawMemories, rawMembers, assetsById, now),
    trips: buildTripMemories(
      rawMemories,
      rawMembers,
      assetsById,
      places,
      homeKey
    ),
    similar: buildSimilarMemories(rawMemories, rawMembers, assetsById),
  };
}

/** `true` when every section is empty — the screen's cue to show the
 *  explainer instead of three empty shelves (honest empty states). */
export function hasNoMemories(model: MemoriesModel): boolean {
  return (
    model.onThisDay === null &&
    model.trips.length === 0 &&
    model.similar.length === 0
  );
}

/** A trip's date-range label, e.g. "Jan 5 - Jan 8, 2026", falling back to the
 *  title_hint's day count when either endpoint is missing rather than
 *  printing a partial or fabricated range. */
export function tripDateLabel(trip: TripMemory): string | null {
  if (!trip.startedAt || !trip.endedAt) return trip.titleHint;
  const start = new Date(trip.startedAt);
  const end = new Date(trip.endedAt);
  const fmt = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  });
  const yearFmt = new Intl.DateTimeFormat("en-US", { year: "numeric" });
  return `${fmt.format(start)} – ${fmt.format(end)}, ${yearFmt.format(end)}`;
}

/** How many years ago an on-this-day year group is from `now`, for the
 *  "X years ago" heading. */
export function yearsAgo(year: string, now: Date): number {
  return now.getFullYear() - Number(year);
}
