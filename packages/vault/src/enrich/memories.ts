import type { DatabaseSync } from "node:sqlite";

import { nowIso } from "../ids.js";
import { UnionFind } from "./clusters.js";
import type {
  MemoryProjectionDraft,
  MemoryProjectionResult,
} from "./memories-fingerprint.js";
import { beginMemoryProjectionPass } from "./memories-fingerprint.js";

export const TRIP_GAP_DAYS = 2;

export const TRIP_MIN_AWAY_DAYS = 2;

export const SIMILAR_MIN_GROUP_SIZE = 2;

export const ON_THIS_DAY_MIN_YEARS = 2;

export type MemoriesRebuildResult = MemoryProjectionResult;

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

type MemoryDraft = MemoryProjectionDraft;

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

function buildOnThisDay(assets: readonly AssetRow[]): MemoryDraft[] {
  const byDayKey = new Map<string, { assetId: string; year: string }[]>();
  const capturedAtByAsset = new Map<string, string | null>();
  for (const asset of assets) {
    capturedAtByAsset.set(asset.asset_id, asset.captured_at);
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
        WHERE p.cluster_id IS NOT NULL
        ORDER BY p.asset_id`
    )
    .all() as unknown as PhashRow[];

  const homePlaceId = resolveHomePlace(vault, assets);
  const pass = beginMemoryProjectionPass(vault, [
    assets,
    phashRows,
    homePlaceId,
  ]);
  if (pass.reused) return pass.reused;

  const onThisDay = buildOnThisDay(assets);
  const trips = buildTrips(assets, homePlaceId);
  const similar = buildSimilar(assets, phashRows);
  const drafts = [...onThisDay, ...trips, ...similar];
  const projection = pass.finish(drafts);
  if (projection.result.reused) {
    projection.remember();
    return projection.result;
  }

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
      });
    }
    vault.exec("COMMIT");
    projection.remember();
    return projection.result;
  } catch (error) {
    vault.exec("ROLLBACK");
    throw error;
  }
}
