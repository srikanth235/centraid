// The Duplicates shelf, as a model (Photos v4 handoff §5, proto:4436-4442).
//
// The prototype's shelf is not a flat grid of "suspect" photographs — it is a
// list of CLUSTERS, each one headed `Cluster 1 · 3 near-identical` with the
// honest reason beside it (`within 2 seconds · 4.1 MB each`). The cluster is
// the unit the member decides about, because the question is never "is this
// one photograph a duplicate" but "which of these copies do I keep".
//
// The grouping key is the perceptual hash the timeline already carries
// (`timeline-model.ts` derives `duplicateHint` from exactly this grouping and
// then collapses it to a per-asset boolean). Nothing new is computed or
// stored: a cluster is a read-time view over rows that are already loaded, so
// there is no "dismiss" write and nothing to un-set.
//
// This module is deliberately free of `react-native` imports so the grouping
// and the two meta lines can be asserted directly (`duplicate-clusters.test.ts`).
// `DuplicatesShelf.tsx` renders them and adds nothing.

import { formatBytes } from "@centraid/design";

import type { PhotoAsset } from "./timeline-model";

/** One group of near-identical copies, keyed by the hash they share. */
export interface DuplicateCluster {
  /** The perceptual hash every copy in this cluster carries. */
  key: string;
  assets: PhotoAsset[];
}

/**
 * Group the loaded timeline into clusters of near-identical copies.
 *
 * A trashed photograph is excluded: it has already been decided about, and
 * leaving it in would offer the member a choice they have made. A cluster of
 * one is not a cluster — after the exclusion, a hash with a single survivor
 * drops out rather than rendering a one-tile "duplicate".
 *
 * Order is the order the assets arrive in (the timeline's own, newest first),
 * so the shelf's `Cluster N` ordinals are stable for a given snapshot.
 */
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

/**
 * The time window a cluster's copies were taken across (proto:4439, `within 2
 * seconds`). Printed only when EVERY copy carries a real timestamp — a window
 * computed from a partial set understates the true span, which is a wrong
 * number rather than a rounded one. `null` says so honestly; the caller omits
 * the phrase rather than inventing one.
 *
 * Mirrors `fmtClusterWindow` in the web's `components/Duplicates.tsx`; the two
 * clients must not describe the same cluster differently.
 */
export function clusterWindow(assets: readonly PhotoAsset[]): string | null {
  if (assets.length < 2) return null;
  // "EVERY copy carries a real timestamp" now includes assets whose
  // `capturedAt` is absent entirely (`timeline-model.ts`): an undated copy is
  // a missing timestamp, not a zero one, and `new Date(undefined)` would make
  // it NaN only by accident. Refused explicitly instead.
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

/**
 * The per-copy size (proto:4439, `4.1 MB each`) — the mean of the cluster's
 * own recorded byte sizes. Printed only when every copy recorded one: a mean
 * over a partial set claims to describe copies it never measured.
 */
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

/** The cluster header's leading half (proto:4439). */
export function clusterLabel(cluster: DuplicateCluster, index: number): string {
  return `Cluster ${index + 1} · ${cluster.assets.length} near-identical`;
}

/**
 * The cluster header's trailing half: the window, then the size, joined only
 * where each is known. `null` when neither is — the header then carries its
 * label alone rather than an empty separator.
 */
export function clusterMeta(cluster: DuplicateCluster): string | null {
  const parts = [
    clusterWindow(cluster.assets),
    clusterSize(cluster.assets),
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}
