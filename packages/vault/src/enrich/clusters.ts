// Near-duplicate clustering (issue #352 phase 3/4): the missing app-plane
// read path over the Tier-0 phash sidecar (issue #299 §2). The infra —
// `media_asset_phash` + the `vault_hamming` SQL function — already exists
// (enrich/similarity.ts), but consent.app_view supports no SQL functions and
// media_asset_phash was not a registered logical entity, so no app query
// could reach it (see packages/blueprints/apps/photos/queries/duplicates.js's
// header for the exact gap this closes).
//
// The fix is a REBUILDABLE PROJECTION, not a new durable fact: a
// `cluster_id` column on `media_asset_phash` (schema/enrich.ts), recomputed
// wholesale on the standing sweep (gateway.ts `sweep`) by this module. A
// rebuild from `media_asset_phash` alone always reproduces the same
// clustering (deterministic cluster ids — see below), so nothing here is
// ever authored data an app or agent could disagree with.

import type { DatabaseSync } from 'node:sqlite';
import { hexHamming } from './similarity.js';

/** Two phashes within this hamming distance cluster together (issue #352). */
export const DUPLICATE_HAMMING_THRESHOLD = 6;

export interface ClusterRecomputeResult {
  /** Distinct clusters with 2+ live members. */
  clusters: number;
  /** Live assets that landed in some cluster (excludes singletons). */
  clustered: number;
}

/** Union-find over asset ids, path-compressed. */
class UnionFind {
  private readonly parent = new Map<string, string>();

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: string): string {
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root) ?? root;
    let cur = id;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur) as string;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * Recompute near-duplicate clusters over LIVE (non-deleted) media assets:
 * group any pair of phashes within `threshold` hamming distance (transitively
 * — union-find, so A~B~C clusters even when A and C individually exceed the
 * threshold), then stamp each group's LOWEST asset_id as its `cluster_id` —
 * deterministic, so unchanged membership never shuffles the id an app is
 * displaying. Singletons (and every asset whose owning row is trashed) carry
 * NULL. Brute-force O(n^2) hamming, matching `scanEmbeddings`'s stance in
 * similarity.ts: a personal vault holds thousands of assets, not billions.
 */
export function recomputeDuplicateClusters(
  vault: DatabaseSync,
  options: { threshold?: number } = {},
): ClusterRecomputeResult {
  const threshold = options.threshold ?? DUPLICATE_HAMMING_THRESHOLD;
  const rows = vault
    .prepare(
      `SELECT p.asset_id AS asset_id, p.phash AS phash FROM media_asset_phash p
         JOIN media_media_asset a ON a.asset_id = p.asset_id
        WHERE a.deleted_at IS NULL`,
    )
    .all() as { asset_id: string; phash: string }[];

  const uf = new UnionFind();
  for (const row of rows) uf.add(row.asset_id);
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const d = hexHamming(rows[i]!.phash, rows[j]!.phash);
      if (d !== null && d <= threshold) uf.union(rows[i]!.asset_id, rows[j]!.asset_id);
    }
  }
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const root = uf.find(row.asset_id);
    const members = groups.get(root);
    if (members) members.push(row.asset_id);
    else groups.set(root, [row.asset_id]);
  }
  const clusterOf = new Map<string, string>();
  let clusters = 0;
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const clusterId = [...members].sort()[0] as string;
    clusters += 1;
    for (const m of members) clusterOf.set(m, clusterId);
  }

  // Wholesale reset first: a trashed asset, or one whose phash dropped out of
  // its old cluster, must not keep a stale cluster_id from a prior sweep —
  // this column has no independent lifecycle of its own (header comment).
  vault.exec('UPDATE media_asset_phash SET cluster_id = NULL');
  const update = vault.prepare('UPDATE media_asset_phash SET cluster_id = ? WHERE asset_id = ?');
  for (const [assetId, clusterId] of clusterOf) update.run(clusterId, assetId);

  return { clusters, clustered: clusterOf.size };
}
