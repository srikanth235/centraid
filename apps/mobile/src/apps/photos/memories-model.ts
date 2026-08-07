// Memories, as a model (issue #724 W7, "Memories v0").
//
// WHAT CHANGED. `photos-collections.ts`'s "Memories" shelf has always been an
// honest explainer over ONE kind, computed purely client-side from whatever
// is currently loaded in the timeline (`timeline-model.ts#onThisDay`): today's
// month-day, filtered to years strictly before this one. That still works —
// it is untouched — but it can only ever know about the day the app happens
// to be open on, and it has no notion of "Trips" or "Similar moments" at all,
// because those need signals (place history, phash/burst grouping) the
// timeline's loaded window does not carry consistently.
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
  /** Resolved from the caller's own place rows — this module does no I/O. */
  placeName: string | null;
  /** e.g. "3-day trip" — straight off `media_memory.title_hint`. */
  titleHint: string | null;
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
/** A raw `media.memory_member` row. */
export type RawMemoryMemberRow = Readonly<Record<string, unknown>>;

function textOf(row: RawMemoryRow, column: string): string | null {
  const value = row[column];
  return value === null || value === undefined ? null : String(value);
}

/**
 * Every asset reachable by BOTH ids it answers to — `id` (the timeline row's
 * own key) and `assetId` (`media_media_asset.asset_id`, what
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
 * trip first. `places` resolves `place_id` to a display name; a trip whose
 * place is not (yet) in the caller's own place rows still renders with
 * `placeName: null` rather than being dropped, since the photographs
 * themselves are the point of the shelf.
 */
export function buildTripMemories(
  rawMemories: readonly RawMemoryRow[],
  rawMembers: readonly RawMemoryMemberRow[],
  assetsById: ReadonlyMap<string, PhotoAsset>,
  places: ReadonlyMap<string, string>
): TripMemory[] {
  const membersByMemory = memberIdsByMemory(rawMembers);
  const trips: TripMemory[] = [];
  for (const row of rawMemories) {
    if (textOf(row, "kind") !== "trip") continue;
    const memoryId = String(row.memory_id);
    const assets = resolveMembers(membersByMemory.get(memoryId), assetsById);
    if (assets.length === 0) continue;
    const placeId = textOf(row, "place_id");
    trips.push({
      memoryId,
      placeId,
      placeName: placeId ? (places.get(placeId) ?? null) : null,
      titleHint: textOf(row, "title_hint"),
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
  places: ReadonlyMap<string, string>,
  now: Date
): MemoriesModel {
  const assetsById = indexAssetsById(assets);
  return {
    onThisDay: buildOnThisDayMemory(rawMemories, rawMembers, assetsById, now),
    trips: buildTripMemories(rawMemories, rawMembers, assetsById, places),
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
  const fmt = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  });
  const yearFmt = new Intl.DateTimeFormat(undefined, { year: "numeric" });
  return `${fmt.format(start)} – ${fmt.format(end)}, ${yearFmt.format(end)}`;
}

/** How many years ago an on-this-day year group is from `now`, for the
 *  "X years ago" heading. */
export function yearsAgo(year: string, now: Date): number {
  return now.getFullYear() - Number(year);
}
