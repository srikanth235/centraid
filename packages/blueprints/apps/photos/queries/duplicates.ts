import { inList, readPages } from "../../_shared/paged-reads.ts";
/**
 * Near-duplicate clusters over the live library (#352 phase 3/4 —
 * closing #299's deferred "duplicates shelf").
 *
 * THE SIMILARITY SIGNAL IS THE SERVER'S, never an exact-sha group plus a
 * "same dimensions + same byte size" fingerprint, which is coincidence-prone:
 *   - `media.asset_phash` is a registered logical entity (schema/tables.ts)
 *     an app with `{schema:'media', verbs:'read'}` can read directly.
 *   - `cluster_id` is a column the standing sweep recomputes wholesale
 *     every run (enrich/clusters.ts's `recomputeDuplicateClusters` —
 *     union-find over phash hamming distance ≤ 6, deterministic id = the
 *     group's lowest asset_id), so reading `WHERE cluster_id IS NOT NULL`
 *     and grouping client-side is a real visual-similarity signal.
 *
 * This query does the read + group + join to content, nothing more — the
 * clustering itself already happened server-side.
 */
import {
  ownerKey,
  readRepresentations,
} from "../../_shared/representation-reads.ts";
import { srcOf } from "./_shared.ts";

/** How many clustered fingerprints the review surface considers. */
const CLUSTER_ROWS = 4000;

interface RawPhash {
  cluster_id: string;
  asset_id: string;
}

interface RawAsset {
  asset_id: string;
  content_id: string;
  title?: string | null;
  kind?: string | null;
  width?: number | null;
  height?: number | null;
  captured_at?: string | null;
}

interface RawContent {
  content_id: string;
  content_uri?: unknown;
  byte_size?: number | null;
  created_at?: string | null;
  deleted_at?: string | null;
}

export default async function duplicatesHandler({ ctx }: HandlerArgs) {
  try {
    const phashPage = await ctx.vault.page<RawPhash>({
      query: {
        name: "photos.duplicates.phashes",
        select: "asset_id, phash, cluster_id, computed_at",
        from: "media_asset_phash",
        where: "cluster_id IS NOT NULL",
        order: {
          sortColumn: "cluster_id",
          pkColumn: "asset_id",
          descending: false,
        },
      },
      limit: CLUSTER_ROWS,
    });
    const rows = phashPage.rows;
    if (rows.length === 0) return { clusters: [] };

    const assetIdsByCluster = new Map<string, string[]>();
    for (const r of rows) {
      if (!assetIdsByCluster.has(r.cluster_id))
        assetIdsByCluster.set(r.cluster_id, []);
      assetIdsByCluster.get(r.cluster_id)!.push(r.asset_id);
    }
    const allAssetIds = [...new Set(rows.map((r) => r.asset_id))];

    // Only LIVE assets ride into a cluster card — a trashed member of an
    // old cluster is not something to offer trashing again. Clusters left
    // with fewer than 2 live members are dropped entirely below.
    const assetIn = inList("asset_id", allAssetIds);
    const assetRows = await readPages<RawAsset>(ctx, {
      name: "photos.duplicates.assets",
      select:
        "asset_id, content_id, kind, title, captured_at, width, height, deleted_at",
      from: "media_asset",
      where: `${assetIn.sql} AND deleted_at IS NULL`,
      bind: assetIn.bind,
      order: {
        sortColumn: "asset_id",
        pkColumn: "asset_id",
        descending: false,
      },
    });
    const assetById = new Map(assetRows.map((a) => [a.asset_id, a] as const));

    const contentIds = [
      ...new Set(
        [...assetById.values()].map((a) => a.content_id).filter(Boolean)
      ),
    ];
    const contents =
      contentIds.length > 0
        ? await readPages<RawContent>(ctx, {
            name: "photos.duplicates.contents",
            select: "content_id, content_uri, byte_size",
            from: "core_content_item",
            where: inList("content_id", contentIds).sql,
            bind: inList("content_id", contentIds).bind,
            order: {
              sortColumn: "content_id",
              pkColumn: "content_id",
              descending: false,
            },
          })
        : [];
    const contentById = new Map(
      contents.map((c) => [c.content_id, c] as const)
    );
    // Bytes carry no media type since #996 (R20(b)); the asset's own title is
    // on the asset row.
    const representations = await readRepresentations({ ctx, contentIds });

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
        media_type:
          representations.byOwner.get(
            ownerKey("media.asset", asset.asset_id)
          ) ?? null,
        title: asset.title ?? null,
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
      clusters.push({ key: clusterId, tier: "phash", assets });
    }
    clusters.sort((a, b) => b.assets.length - a.assets.length);
    return { clusters };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code === "VAULT_ACCESS") {
      return {
        clusters: [],
        vaultDenied: { code: e.code, message: e.message },
      };
    }
    return { clusters: [], error: String(e.message ?? error) };
  }
}
