/**
 * Near-duplicate clusters over the live library (issue #352 phase 3/4 —
 * closing #299's deferred "duplicates shelf").
 *
 * A prior wave of this app fell back to an approximation here: exact-sha
 * groups plus a "same dimensions + same byte size" coarse fingerprint,
 * because `media_asset_phash` wasn't a registered logical entity and
 * `cluster_id` didn't exist yet (see git history of this file for that
 * version's full reasoning). Both gaps are closed server-side now:
 *   - `media.asset_phash` is a registered logical entity (schema/tables.ts)
 *     an app with `{schema:'media', verbs:'read'}` can read directly.
 *   - `cluster_id` is a column the standing sweep recomputes wholesale
 *     every run (enrich/clusters.ts's `recomputeDuplicateClusters` —
 *     union-find over phash hamming distance ≤ 6, deterministic id = the
 *     group's lowest asset_id), so reading `WHERE cluster_id IS NOT NULL`
 *     and grouping client-side is now a real visual-similarity signal, not
 *     a coincidence-prone fingerprint.
 *
 * This query does the read + group + join to content, nothing more — the
 * clustering itself already happened server-side.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */
import { srcOf } from './_shared.ts';

interface RawPhash {
  cluster_id: string;
  asset_id: string;
}

interface RawAsset {
  asset_id: string;
  content_id: string;
  kind?: string | null;
  width?: number | null;
  height?: number | null;
  captured_at?: string | null;
}

interface RawContent {
  content_id: string;
  content_uri?: unknown;
  byte_size?: number | null;
  media_type?: string | null;
  title?: string | null;
  created_at?: string | null;
  deleted_at?: string | null;
}

export default async ({ ctx }: HandlerArgs) => {
  const purpose = 'dpv:ServiceProvision';
  try {
    const phashRows = await ctx.vault.read({
      entity: 'media.asset_phash',
      where: [{ column: 'cluster_id', op: 'not-null' }],
      limit: 4000,
      purpose,
    });
    const rows = (phashRows.rows ?? []) as unknown as RawPhash[];
    if (rows.length === 0) return { clusters: [] };

    const assetIdsByCluster = new Map<string, string[]>();
    for (const r of rows) {
      if (!assetIdsByCluster.has(r.cluster_id)) assetIdsByCluster.set(r.cluster_id, []);
      assetIdsByCluster.get(r.cluster_id)!.push(r.asset_id);
    }
    const allAssetIds = [...new Set(rows.map((r) => r.asset_id))];

    // Only LIVE assets ride into a cluster card — a trashed member of an
    // old cluster is not something to offer trashing again. Clusters left
    // with fewer than 2 live members are dropped entirely below.
    const assetsResult = await ctx.vault.read({
      entity: 'media.media_asset',
      where: [
        { column: 'asset_id', op: 'in', value: allAssetIds },
        { column: 'deleted_at', op: 'is-null' },
      ],
      limit: 4000,
      purpose,
    });
    const assetById = new Map(
      ((assetsResult.rows ?? []) as unknown as RawAsset[]).map((a) => [a.asset_id, a] as const),
    );

    const contentIds = [
      ...new Set([...assetById.values()].map((a) => a.content_id).filter(Boolean)),
    ];
    const contents =
      contentIds.length > 0
        ? await ctx.vault.read({
            entity: 'core.content_item',
            where: [{ column: 'content_id', op: 'in', value: contentIds }],
            purpose,
          })
        : { rows: [] };
    const contentById = new Map(
      ((contents.rows ?? []) as unknown as RawContent[]).map((c) => [c.content_id, c] as const),
    );

    const rowFor = (assetId: string) => {
      const asset = assetById.get(assetId);
      const content = asset ? contentById.get(asset.content_id) : undefined;
      if (!asset || !content || content.deleted_at != null) return null;
      const { src, thumb, preview, poster } = srcOf(content);
      return {
        asset_id: asset.asset_id,
        content_id: asset.content_id,
        kind: asset.kind,
        width: asset.width ?? null,
        height: asset.height ?? null,
        byte_size: content.byte_size ?? null,
        media_type: content.media_type ?? null,
        title: content.title ?? null,
        taken_at: asset.captured_at ?? content.created_at ?? null,
        content_uri: src,
        thumb_uri: thumb,
        preview_uri: preview,
        poster_uri: poster,
      };
    };

    const clusters = [];
    for (const [clusterId, assetIds] of assetIdsByCluster) {
      const assets = assetIds.map(rowFor).filter((a) => a != null);
      if (assets.length < 2) continue;
      clusters.push({ key: clusterId, tier: 'phash', assets });
    }
    clusters.sort((a, b) => b.assets.length - a.assets.length);
    return { clusters };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === 'VAULT_CONSENT') {
      return { clusters: [], vaultDenied: { code: e.code, message: e.message } };
    }
    return { clusters: [], error: String(e.message ?? err) };
  }
};
