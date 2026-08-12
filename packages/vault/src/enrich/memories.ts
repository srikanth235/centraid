// Memories v0 (issue #724 W7) — a REBUILDABLE, DERIVED, NEVER-AUTHORED
// projection over signals the vault already carries. Same mold as
// `clusters.ts` exactly: a standing sweep drops and reinserts the whole
// projection (schema/enrich.ts's `media_memory` / `media_memory_member`) from
// the source tables alone, so it is always safe to delete both tables and
// let the next sweep rebuild them. There is no ML dependency and no
// dependence on the other #724 workstreams — every input here is a column
// this schema already had before this file existed.
//
// THREE KINDS, ONE HEURISTIC EACH:
//
//   'on-this-day' — assets whose capture-local day (captured_at shifted by
//   tz_offset_min when the camera recorded one, else the raw UTC date —
//   there is no viewing device to fall back to on the server, unlike
//   apps/mobile/src/apps/photos/timeline-model.ts's `captureLocalDay`) shares
//   a month-day (`day_key`, 'MM-DD') with an asset from a DIFFERENT year.
//   Grouped by day-of-year, not by "today": the sweep has no wall-clock
//   opinion about which day is today, so the same row serves every day of
//   the year it is asked about, and a rebuild run in January produces
//   byte-identical July rows to one run in July. A mobile client narrows to
//   "today" by filtering `day_key` at READ time (`memories-model.ts`). A
//   day_key with photos from only one year is not a memory of anything —
//   ON_THIS_DAY_MIN_YEARS enforces that.
//
//   'trip' — a maximal run of capture-local days whose modal place differs
//   from the owner's home place. "Home" prefers the `core_place` row an
//   owner has tagged `kind = 'home'`; absent that, it falls back to the
//   modal place across every dated, placed asset (deterministic tie-break:
//   the lowest place_id). TRIP_GAP_DAYS lets a short run of photo-less days
//   (a travel day, a low-activity afternoon) bridge into the SAME trip
//   rather than fragmenting one vacation into three memories — real
//   vacations are not photographed every single day. TRIP_MIN_AWAY_DAYS
//   keeps a single day trip out to the next town (which is a day, not a
//   "trip" a member would want resurfaced as one) from cluttering the
//   shelf. A trip's MEMBERS are every dated asset captured within its away
//   date range inclusive, not only the assets that supplied the away
//   signal — once the date range is known, a home-place photo squeezed into
//   it (say, a same-day return) still belongs to the trip's story.
//
//   'similar' — near-duplicate/burst groups: the union (via the same
//   `UnionFind` `clusters.ts` uses for phash grouping) of
//   `media_asset_phash.cluster_id` groups and `capture_group_id` groups, so a
//   Live Photo pair and a burst of visually-identical shots both surface as
//   one memory even when only one of the two signals fired for a given
//   asset. SIMILAR_MIN_GROUP_SIZE keeps a singleton (an asset with a
//   capture_group_id or cluster_id but no actual companion left after
//   trashes) from becoming a one-photo "memory".
//
// HONEST ABSENCE. An asset with NULL `captured_at` can never enter
// 'on-this-day' or 'trip' — both are date-keyed by construction, so there is
// no day to group it under. It CAN enter 'similar', which keys on
// phash/capture-group identity, never on when the shutter fired.
//
// DETERMINISTIC IDS, NO WALL CLOCK IN GROUPING. `memory_id` is a readable
// composite string derived from the kind plus the grouping's own stable key:
// `otd:<day_key>`, `trip:<first away day>` (a calendar day can start at most
// one trip), `similar:<lowest asset_id in the group>` (the same "lowest id
// is the identity" rule `clusters.ts` uses for `cluster_id`). No
// `randomblob`, and the grouping logic itself never reads `options.now` —
// only the `computed_at` audit column does, so two rebuilds of the same
// underlying data produce byte-identical `media_memory` /
// `media_memory_member` rows regardless of when either sweep ran.
//
// COST. v0 keeps the rebuild simple: one full read of the source tables, an
// in-memory group, then DELETE-ALL + REINSERT in one transaction — no
// incremental fingerprint short-circuit like `clusters.ts`'s (issue #659
// G1/G2). That optimization is a defensible follow-up once this sweep shows
// up in a nightly profile; a first version over three cheap, already-indexed
// source tables does not need it yet.

import type { DatabaseSync } from "node:sqlite";

import { nowIso } from "../ids.js";
import { UnionFind } from "./clusters.js";

/**
 * Two calendar days with a gap of this many photo-less days still count as
 * the SAME trip (see the module header). Chosen conservatively: real trips
 * routinely have a quiet day or a travel day with nothing captured, and a
 * threshold this small still keeps two vacations weeks apart from merging.
 */
export const TRIP_GAP_DAYS = 2;

/**
 * A trip needs at least this many distinct AWAY calendar days. A single day
 * out is a day, not a "trip" worth resurfacing as its own memory.
 */
export const TRIP_MIN_AWAY_DAYS = 2;

/** A similar-moment group needs at least this many members — one photo is
 *  not a "similar moment". */
export const SIMILAR_MIN_GROUP_SIZE = 2;

/** An on-this-day group needs assets from at least this many distinct years
 *  — a day with photos from only one year has no "on this day" to offer. */
export const ON_THIS_DAY_MIN_YEARS = 2;

export interface MemoriesRebuildResult {
  onThisDay: number;
  trips: number;
  similar: number;
  /** Total rows written to `media_memory_member` across every memory. */
  members: number;
}

interface AssetRow {
  asset_id: string;
  captured_at: string | null;
  tz_offset_min: number | null;
  place_id: string | null;
  capture_group_id: string | null;
}

interface PhashRow {
  asset_id: string;
  cluster_id: string | null;
}

interface MemoryDraft {
  memoryId: string;
  kind: "on-this-day" | "trip" | "similar";
  titleHint: string | null;
  dayKey: string | null;
  placeId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Capture order (or, for undated members, asset_id order) — the row's
   *  `ordinal` on insert. */
  members: readonly string[];
}

/**
 * The calendar day an asset was captured, server-side. Shifts by
 * `tz_offset_min` when the camera recorded one — the same rule
 * `timeline-model.ts`'s `captureLocalDay` uses for its own tz branch — and
 * falls back to the raw UTC date slice otherwise, because there is no
 * viewing device on the server to fall back to instead.
 */
function captureLocalDay(
  capturedAt: string,
  tzOffsetMin: number | null
): string {
  if (tzOffsetMin === null) return capturedAt.slice(0, 10);
  return new Date(Date.parse(capturedAt) + tzOffsetMin * 60_000)
    .toISOString()
    .slice(0, 10);
}

function compareCapturedAt(
  a: string,
  b: string,
  capturedAtByAsset: ReadonlyMap<string, string | null>
): number {
  const ca = capturedAtByAsset.get(a) ?? null;
  const cb = capturedAtByAsset.get(b) ?? null;
  if (ca === null && cb === null) return a < b ? -1 : a > b ? 1 : 0;
  if (ca === null) return 1;
  if (cb === null) return -1;
  if (ca < cb) return -1;
  if (ca > cb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The most common value in `counts`, ties broken by the lowest key. */
function modalKey(counts: ReadonlyMap<string, number>): string | null {
  let best: string | null = null;
  let bestCount = -1;
  for (const [key, count] of [...counts].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The owner's "home" place: their own `core_place.kind = 'home'` tag when one
 * exists (lowest place_id on a tie), else the modal place across every
 * dated, placed asset. `null` when neither signal exists — a vault with no
 * place data anywhere has nothing to call "away", so no trip can be detected
 * from it.
 */
function resolveHomePlace(
  vault: DatabaseSync,
  assets: readonly AssetRow[]
): string | null {
  const tagged = vault
    .prepare(
      "SELECT place_id FROM core_place WHERE kind = 'home' ORDER BY place_id LIMIT 1"
    )
    .get() as { place_id: string } | undefined;
  if (tagged) return tagged.place_id;
  const counts = new Map<string, number>();
  for (const asset of assets) {
    if (asset.place_id === null) continue;
    counts.set(asset.place_id, (counts.get(asset.place_id) ?? 0) + 1);
  }
  return modalKey(counts);
}

/**
 * 'on-this-day': group live, dated assets by month-day. A group with fewer
 * than `ON_THIS_DAY_MIN_YEARS` distinct years behind it is not a memory —
 * see the module header.
 */
function buildOnThisDay(assets: readonly AssetRow[]): MemoryDraft[] {
  const byDayKey = new Map<string, { assetId: string; year: string }[]>();
  const capturedAtByAsset = new Map<string, string | null>();
  for (const asset of assets) {
    capturedAtByAsset.set(asset.asset_id, asset.captured_at);
    // Honest absence: an asset with no captured_at has no day to group by.
    if (asset.captured_at === null) continue;
    const localDay = captureLocalDay(asset.captured_at, asset.tz_offset_min);
    const dayKey = localDay.slice(5);
    const year = localDay.slice(0, 4);
    const list = byDayKey.get(dayKey) ?? [];
    list.push({ assetId: asset.asset_id, year });
    byDayKey.set(dayKey, list);
  }
  const drafts: MemoryDraft[] = [];
  for (const [dayKey, entries] of [...byDayKey].sort(([a], [b]) =>
    a < b ? -1 : 1
  )) {
    const years = new Set(entries.map((entry) => entry.year));
    if (years.size < ON_THIS_DAY_MIN_YEARS) continue;
    const members = entries
      .map((entry) => entry.assetId)
      .sort((a, b) => compareCapturedAt(a, b, capturedAtByAsset));
    drafts.push({
      memoryId: `otd:${dayKey}`,
      kind: "on-this-day",
      titleHint: null,
      dayKey,
      placeId: null,
      startedAt: capturedAtByAsset.get(members[0]!) ?? null,
      endedAt: capturedAtByAsset.get(members.at(-1)!) ?? null,
      members,
    });
  }
  return drafts;
}

function daysBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(later) - Date.parse(earlier)) / 86_400_000);
}

/**
 * 'trip': maximal runs of away days (see the module header for the gap and
 * minimum-length constants). Returns nothing when there is no home place to
 * compare against.
 */
function buildTrips(
  assets: readonly AssetRow[],
  homePlaceId: string | null
): MemoryDraft[] {
  if (homePlaceId === null) return [];
  const capturedAtByAsset = new Map<string, string | null>();
  const assetsByDay = new Map<string, string[]>();
  const placeCountsByDay = new Map<string, Map<string, number>>();
  for (const asset of assets) {
    capturedAtByAsset.set(asset.asset_id, asset.captured_at);
    if (asset.captured_at === null) continue;
    const day = captureLocalDay(asset.captured_at, asset.tz_offset_min);
    const ids = assetsByDay.get(day) ?? [];
    ids.push(asset.asset_id);
    assetsByDay.set(day, ids);
    if (asset.place_id === null) continue;
    const counts = placeCountsByDay.get(day) ?? new Map<string, number>();
    counts.set(asset.place_id, (counts.get(asset.place_id) ?? 0) + 1);
    placeCountsByDay.set(day, counts);
  }
  const modalPlaceByDay = new Map<string, string>();
  for (const [day, counts] of placeCountsByDay) {
    const best = modalKey(counts);
    if (best !== null) modalPlaceByDay.set(day, best);
  }
  const awayDays = [...modalPlaceByDay.entries()]
    .filter(([, placeId]) => placeId !== homePlaceId)
    .map(([day]) => day)
    .sort();

  const runs: string[][] = [];
  for (const day of awayDays) {
    const current = runs.at(-1);
    const previous = current?.at(-1);
    // A gap this small keeps the SAME trip going (module header); a bigger
    // one starts a new run.
    if (
      previous !== undefined &&
      daysBetween(previous, day) <= TRIP_GAP_DAYS + 1
    ) {
      current!.push(day);
      continue;
    }
    runs.push([day]);
  }

  const drafts: MemoryDraft[] = [];
  for (const run of runs) {
    if (run.length < TRIP_MIN_AWAY_DAYS) continue;
    const startDay = run[0]!;
    const endDay = run.at(-1)!;
    const members: string[] = [];
    for (const [day, ids] of assetsByDay) {
      if (day >= startDay && day <= endDay) members.push(...ids);
    }
    // Every away day carries at least one dated asset by construction (it is
    // how the day entered modalPlaceByDay), so members is never empty here.
    members.sort((a, b) => compareCapturedAt(a, b, capturedAtByAsset));
    const placeCounts = new Map<string, number>();
    for (const day of run) {
      const placeId = modalPlaceByDay.get(day);
      if (placeId === undefined) continue;
      placeCounts.set(placeId, (placeCounts.get(placeId) ?? 0) + 1);
    }
    drafts.push({
      memoryId: `trip:${startDay}`,
      kind: "trip",
      titleHint: `${run.length}-day trip`,
      dayKey: null,
      placeId: modalKey(placeCounts),
      startedAt: capturedAtByAsset.get(members[0]!) ?? null,
      endedAt: capturedAtByAsset.get(members.at(-1)!) ?? null,
      members,
    });
  }
  return drafts;
}

/**
 * 'similar': the union of phash-cluster groups and capture-group groups over
 * LIVE assets. An asset that carries neither signal never enters a group —
 * `UnionFind.add` is only called for assets that participate in at least one
 * of the two source groupings, so an ordinary, unrelated photograph never
 * becomes a spurious singleton "memory".
 */
function buildSimilar(
  assets: readonly AssetRow[],
  phashRows: readonly PhashRow[]
): MemoryDraft[] {
  const liveAssetIds = new Set(assets.map((asset) => asset.asset_id));
  const capturedAtByAsset = new Map(
    assets.map((asset) => [asset.asset_id, asset.captured_at] as const)
  );
  const byCluster = new Map<string, string[]>();
  for (const row of phashRows) {
    if (row.cluster_id === null || !liveAssetIds.has(row.asset_id)) continue;
    const list = byCluster.get(row.cluster_id) ?? [];
    list.push(row.asset_id);
    byCluster.set(row.cluster_id, list);
  }
  const byCaptureGroup = new Map<string, string[]>();
  for (const asset of assets) {
    if (asset.capture_group_id === null) continue;
    const list = byCaptureGroup.get(asset.capture_group_id) ?? [];
    list.push(asset.asset_id);
    byCaptureGroup.set(asset.capture_group_id, list);
  }

  const uf = new UnionFind();
  const participated = new Set<string>();
  for (const ids of [...byCluster.values(), ...byCaptureGroup.values()]) {
    for (const id of ids) {
      uf.add(id);
      participated.add(id);
    }
    for (let i = 1; i < ids.length; i += 1) uf.union(ids[0]!, ids[i]!);
  }

  const groups = new Map<string, string[]>();
  for (const id of participated) {
    const root = uf.find(id);
    const list = groups.get(root) ?? [];
    list.push(id);
    groups.set(root, list);
  }

  const drafts: MemoryDraft[] = [];
  for (const members of groups.values()) {
    if (members.length < SIMILAR_MIN_GROUP_SIZE) continue;
    const lowest = [...members].sort()[0]!;
    const sortedMembers = [...members].sort((a, b) =>
      compareCapturedAt(a, b, capturedAtByAsset)
    );
    const dated = sortedMembers.filter(
      (id) => capturedAtByAsset.get(id) !== null
    );
    drafts.push({
      memoryId: `similar:${lowest}`,
      kind: "similar",
      titleHint: null,
      dayKey: null,
      placeId: null,
      startedAt:
        dated.length > 0 ? (capturedAtByAsset.get(dated[0]!) ?? null) : null,
      endedAt:
        dated.length > 0
          ? (capturedAtByAsset.get(dated.at(-1)!) ?? null)
          : null,
      members: sortedMembers,
    });
  }
  return drafts;
}

/**
 * Recompute the whole Memories v0 projection over LIVE (non-deleted) media
 * assets: delete every `media_memory` / `media_memory_member` row and
 * reinsert from the three builders above, in one transaction — the module
 * header explains why this is safe (derived, never authored, deterministic
 * ids) and why v0 does not need `clusters.ts`'s incremental fingerprint yet.
 *
 * `options.now` stamps `computed_at` only; it is never read by any grouping
 * decision above, which is what keeps a rebuild byte-stable across however
 * many times it runs.
 */
export function rebuildMemories(
  vault: DatabaseSync,
  options: { now?: string } = {}
): MemoriesRebuildResult {
  const now = options.now ?? nowIso();
  const assets = vault
    .prepare(
      `SELECT asset_id, captured_at, tz_offset_min, place_id, capture_group_id
         FROM media_asset
        WHERE deleted_at IS NULL
        ORDER BY asset_id`
    )
    .all() as unknown as AssetRow[];
  const phashRows = vault
    .prepare(
      `SELECT p.asset_id AS asset_id, p.cluster_id AS cluster_id
         FROM media_asset_phash p
        WHERE p.cluster_id IS NOT NULL`
    )
    .all() as unknown as PhashRow[];

  const homePlaceId = resolveHomePlace(vault, assets);
  const onThisDay = buildOnThisDay(assets);
  const trips = buildTrips(assets, homePlaceId);
  const similar = buildSimilar(assets, phashRows);
  const drafts = [...onThisDay, ...trips, ...similar];

  vault.exec("BEGIN IMMEDIATE");
  try {
    vault.exec("DELETE FROM media_memory_member");
    vault.exec("DELETE FROM media_memory");
    const insertMemory = vault.prepare(
      `INSERT INTO media_memory
         (memory_id, kind, title_hint, day_key, place_id, started_at, ended_at, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertMember = vault.prepare(
      `INSERT INTO media_memory_member (memory_id, asset_id, ordinal)
       VALUES (?, ?, ?)`
    );
    let members = 0;
    for (const draft of drafts) {
      insertMemory.run(
        draft.memoryId,
        draft.kind,
        draft.titleHint,
        draft.dayKey,
        draft.placeId,
        draft.startedAt,
        draft.endedAt,
        now
      );
      draft.members.forEach((assetId, ordinal) => {
        insertMember.run(draft.memoryId, assetId, ordinal);
        members += 1;
      });
    }
    vault.exec("COMMIT");
    return {
      onThisDay: onThisDay.length,
      trips: trips.length,
      similar: similar.length,
      members,
    };
  } catch (error) {
    vault.exec("ROLLBACK");
    throw error;
  }
}
