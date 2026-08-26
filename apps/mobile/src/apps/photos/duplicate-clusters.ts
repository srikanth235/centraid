// A cluster is a read-time view over already-loaded rows keyed by the phash
// behind `duplicateHint` — nothing is stored, so there is no dismiss to un-set.
// Both meta halves return `null` unless EVERY copy carries the datum.

import { formatBytes } from "@centraid/design";

import type { PhotoAsset } from "./timeline-model";

export interface DuplicateCluster {
  key: string;
  assets: PhotoAsset[];
}

export function duplicateClusters(
  assets: readonly PhotoAsset[]
): DuplicateCluster[] {
  const byHash = new Map<string, PhotoAsset[]>();
  for (const asset of assets) {
    if (!asset.phash || asset.deleted) continue;
    const group = byHash.get(asset.phash);
    if (group) group.push(asset);
    else byHash.set(asset.phash, [asset]);
  }
  const clusters: DuplicateCluster[] = [];
  for (const [key, group] of byHash) {
    if (group.length > 1) clusters.push({ key, assets: group });
  }
  return clusters;
}

/** Mirrors `fmtClusterWindow` in the web's `components/Duplicates.tsx`. */
export function clusterWindow(assets: readonly PhotoAsset[]): string | null {
  if (assets.length < 2) return null;
  if (assets.some((asset) => asset.capturedAt === undefined)) return null;
  const times = assets.map((asset) => new Date(asset.capturedAt!).getTime());
  if (times.some((time) => !Number.isFinite(time))) return null;
  const seconds = Math.round((Math.max(...times) - Math.min(...times)) / 1_000);
  if (seconds <= 1) return "within 1 second";
  if (seconds < 60) return `within ${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60)
    return `within ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  return `within ${hours} ${hours === 1 ? "hour" : "hours"}`;
}

export function clusterSize(assets: readonly PhotoAsset[]): string | null {
  const sizes: number[] = [];
  for (const asset of assets) {
    if (typeof asset.fileSize !== "number" || !Number.isFinite(asset.fileSize))
      return null;
    sizes.push(asset.fileSize);
  }
  if (sizes.length === 0) return null;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return `${formatBytes(total / sizes.length)} each`;
}

export function clusterLabel(cluster: DuplicateCluster, index: number): string {
  return `Cluster ${index + 1} · ${cluster.assets.length} near-identical`;
}

export function clusterMeta(cluster: DuplicateCluster): string | null {
  const parts = [
    clusterWindow(cluster.assets),
    clusterSize(cluster.assets),
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}
