// Memories, as a model (#724, "Memories v0").
//
// NOTHING HERE COMPUTES A MEMORY. This groups and filters rows the vault's own
// sweep (`packages/vault/src/enrich/memories.ts`) already derived into
// `media.memory`/`media.memory_member` — not `photos-collections.ts`'s
// client-side shelf, which only knows the timeline's loaded window. Titles come
// from the shared phrase ladder in `@centraid/blueprints/apps/photos/trips`, so
// the phone and the web strip cannot name one trip two different ways (#816).
//
// HONEST EMPTY STATES — the law this file exists to keep. A shelf must never
// claim to hold something it does not: `buildOnThisDayMemory` returns `null`
// unless today's month-day has a row with a member from a strictly earlier
// year, and the trip/similar builders drop any row whose members do not resolve
// against the assets this phone has loaded.
//
// Deliberately free of `react-native` and replica imports, so the rules are
// assertable directly.
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

export interface MemoryYearGroup {
  year: string;
  assets: PhotoAsset[];
}

export interface OnThisDayMemory {
  memoryId: string;
  /** Newest year first. */
  years: MemoryYearGroup[];
}

export interface TripMemory {
  memoryId: string;
  placeId: string | null;
  /**
   * Read from the places the trip's own MEMBERS were photographed at (#816),
   * not from the row's `place_id`: a coordinate-shaped label is not a name.
   */
  placeName: string | null;
  /** e.g. "3-day trip" — straight off `media_memory.title_hint`. */
  titleHint: string | null;
  /** The phrase ladder's answer, falling back to the bare hint. Never a
   *  coordinate and never relative to home; see `trips.ts`. */
  title: string;
  /** Capture order. Empty when no member carried a usable coordinate. */
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

/** Exactly as `useReplicaQuery` hands it back: string-keyed, values uncast. */
export type RawMemoryRow = Readonly<Record<string, unknown>>;
export type RawMemoryMemberRow = Readonly<Record<string, unknown>>;
export type RawPlaceRow = Readonly<Record<string, unknown>>;

export interface MemoryPlace extends TripPlace {
  isHome?: boolean;
}

/** A coordinate is a NUMBER column or nothing: anything else is dropped by
 *  type rather than coerced and caught as NaN downstream. */
function coordOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Column contract (#787): `core_place` ships `geo_lat`/`geo_lng` and the phone
 * reads replica rows RAW, so the physical columns come first with
 * `latitude`/`lat` as fixture fallbacks — the chain `placePoints` reads.
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
 * Resolved over the WHOLE loaded library, never one trip's members: a trip's
 * modal place is where the member WENT, and calling that home reads every away
 * day as a day at home. A `kind = 'home'` tag wins, as in the vault's rule.
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

/** Keyed by BOTH ids an asset answers to: `id` (the timeline row's key) and
 *  `assetId`, which is what `media_memory_member.asset_id` points at. */
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

/** Deleted or unresolvable ids drop out silently (honest empty states). */
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

/** The viewing device's own calendar — the same reference
 *  `timeline-model.ts#onThisDay` uses, so the two never disagree on "today". */
function todayKey(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${month}-${day}`;
}

/** The vault groups by month-day only, so "today" is applied here. Returns
 *  `null`, never an empty `years` list. */
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
    // Belt and braces: the vault projection already excludes undated assets.
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
 * Newest trip first. A trip whose place is not in `places` still renders,
 * titled by the vault's hint — the photographs are the point of the shelf.
 * `homeKey` only keeps home out of the title and the away-day count.
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
      // Last resort: a trip with neither a named place nor a day count has
      // nothing truer to say.
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

/** Ordered by `memory_id` — stable and arbitrary, which is enough for a rail
 *  with no natural chronology of its own. */
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

export function buildMemoriesModel(
  rawMemories: readonly RawMemoryRow[],
  rawMembers: readonly RawMemoryMemberRow[],
  assets: readonly PhotoAsset[],
  places: ReadonlyMap<string, MemoryPlace>,
  now: Date
): MemoriesModel {
  const assetsById = indexAssetsById(assets);
  // Once over the whole library — see `homePlaceKey` for why a trip's own
  // members are the wrong evidence.
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

/** The screen's cue to show the explainer, not three empty shelves. */
export function hasNoMemories(model: MemoriesModel): boolean {
  return (
    model.onThisDay === null &&
    model.trips.length === 0 &&
    model.similar.length === 0
  );
}

/** Falls back to the title hint when an endpoint is missing, rather than
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

export function yearsAgo(year: string, now: Date): number {
  return now.getFullYear() - Number(year);
}
