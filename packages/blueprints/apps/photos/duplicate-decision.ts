import { assetBytes } from "./format.ts";
import type { Asset } from "./types.ts";

export type KeepReason = "largest" | null;

export interface ClusterDecision {
  keptId: string;
  reason: KeepReason;
  trashIds: string[];
}

function pixelArea(asset: Asset): number | null {
  const { width, height } = asset;
  if (typeof width !== "number" || typeof height !== "number") return null;
  return width * height;
}

function takenAt(asset: Asset): number | null {
  const raw = asset.taken_at ?? asset.captured_at ?? asset.created_at ?? null;
  if (raw == null) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function biggerFirst(a: Asset, b: Asset): number {
  const bytes = (assetBytes(b) ?? -1) - (assetBytes(a) ?? -1);
  if (bytes !== 0) return bytes;
  const area = (pixelArea(b) ?? -1) - (pixelArea(a) ?? -1);
  if (area !== 0) return area;
  const time =
    (takenAt(a) ?? Number.MAX_SAFE_INTEGER) -
    (takenAt(b) ?? Number.MAX_SAFE_INTEGER);
  if (time !== 0) return time;
  return a.asset_id < b.asset_id ? -1 : a.asset_id > b.asset_id ? 1 : 0;
}

function isStrictlyLargest(assets: readonly Asset[], keptId: string): boolean {
  const kept = assets.find((asset) => asset.asset_id === keptId);
  if (!kept) return false;
  const keptBytes = assetBytes(kept);
  if (keptBytes == null) return false;
  return assets.every((asset) => {
    if (asset.asset_id === keptId) return true;
    const other = assetBytes(asset);
    return other != null && other < keptBytes;
  });
}

export function decideCluster(
  assets: readonly Asset[],
  override?: string | null
): ClusterDecision | null {
  if (assets.length === 0) return null;
  const overridden =
    override != null && assets.some((asset) => asset.asset_id === override);
  const proposed = [...assets].sort(biggerFirst)[0]!;
  const keptId = overridden ? override! : proposed.asset_id;
  return {
    keptId,
    reason: isStrictlyLargest(assets, keptId) ? "largest" : null,
    trashIds: assets
      .filter((asset) => asset.asset_id !== keptId)
      .map((asset) => asset.asset_id),
  };
}
