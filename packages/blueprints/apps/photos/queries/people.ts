import { inList, readPages } from "../../_shared/paged-reads.ts";
/**
 * The People shelf's roster (§5). Confirmed people and unconfirmed proposals
 * stay in SEPARATE arrays (#711): a proposal is evidence, not an identity, and
 * has no `name` field. Nothing writes `party_id` and there is no
 * face-similarity signal, so a proposal of one region is honest (#712).
 *
 * @type {import('@centraid/server/engine').QueryHandler}
 */
import { groupPeopleFaces } from "../../_shared/people-counts.ts";
import { srcOf } from "./_shared.ts";

/** The picker offers this many names. */
const PARTY_ROWS = 500;

interface RawRegion {
  region_id: string;
  asset_id?: string | null;
  bbox_json?: unknown;
  party_id?: string | null;
  confirmed_by_party_id?: string | null;
  /** proposed | confirmed | rejected | dismissed (#712). */
  review_state?: string | null;
}

interface RawParty {
  party_id: string;
  kind?: string;
  display_name?: string | null;
}

interface RawCluster {
  region_id: string;
  cluster_id: string;
}

interface RawAsset {
  asset_id: string;
  content_id: string;
  width?: number | null;
  height?: number | null;
}

interface RawContent {
  content_id: string;
  content_uri?: unknown;
}

/** Must match `queries/face-queue.ts` or they disagree on the backlog. */
const REGION_LIMIT = 4000;

/** Bounded to keep the grid's asset+content join cheap. */
const PROPOSAL_LIMIT = 60;

interface ProposalGroup {
  partyId: string | null;
  assetIds: Set<string>;
  coverRegion: RawRegion;
}

export default async function people({ ctx }: HandlerArgs) {
  try {
    const [regionsResult, partiesResult, clustersResult] = await Promise.all([
      ctx.vault.page<RawRegion>({
        query: {
          name: "photos.people.regions",
          select:
            "region_id, asset_id, bbox_json, party_id, confidence, confirmed_by_party_id, review_state",
          from: "media_face_region",
          order: {
            sortColumn: "region_id",
            pkColumn: "region_id",
            descending: false,
          },
        },
        limit: REGION_LIMIT,
      }),
      ctx.vault.page<RawParty>({
        query: {
          name: "photos.people.parties",
          select: "party_id, display_name, kind",
          from: "core_party",
          order: {
            sortColumn: "display_name",
            pkColumn: "party_id",
            descending: false,
          },
        },
        limit: PARTY_ROWS,
      }),
      ctx.vault.page<RawCluster>({
        query: {
          name: "photos.people.clusters",
          select: "region_id, cluster_id, computed_at",
          from: "media_face_cluster",
          order: {
            sortColumn: "region_id",
            pkColumn: "region_id",
            descending: false,
          },
        },
        limit: REGION_LIMIT,
      }),
    ]);
    const regions = regionsResult.rows;
    const clusters = clustersResult.rows;
    const nameOf = new Map(
      partiesResult.rows
        .filter((party) => party.kind === "person")
        .map((party) => [party.party_id, party.display_name] as const)
    );

    const grouped = groupPeopleFaces(regions, clusters);
    const regionById = new Map(
      regions.map((region) => [region.region_id, region] as const)
    );

    // Still-open only: an answered region is nobody's backlog.
    const proposalGroups = new Map<string, ProposalGroup>();
    for (const group of grouped.pendingByParty) {
      const coverRegion = group.coverRegionId
        ? regionById.get(group.coverRegionId)
        : undefined;
      if (!coverRegion) continue;
      proposalGroups.set(`party:${group.id}`, {
        partyId: group.id,
        assetIds: new Set(group.assetIds),
        coverRegion,
      });
    }
    for (const group of grouped.unnamed) {
      const coverRegion = group.coverRegionId
        ? regionById.get(group.coverRegionId)
        : undefined;
      if (!coverRegion) continue;
      proposalGroups.set(`cluster:${group.id}`, {
        partyId: null,
        assetIds: new Set(group.assetIds),
        coverRegion,
      });
    }
    const orderedGroups = [...proposalGroups.entries()].sort(([a], [b]) =>
      a < b ? -1 : 1
    );
    const coverGroups = orderedGroups.slice(0, PROPOSAL_LIMIT);

    const coverAssetIds = [
      ...new Set(
        coverGroups
          .map(([, g]) => g.coverRegion.asset_id)
          .filter((id): id is string => Boolean(id))
      ),
    ];
    const assetsResult = coverAssetIds.length
      ? await readPages<RawAsset>(ctx, {
          name: "photos.people.coverAssets",
          select: "asset_id, content_id, kind, title, captured_at",
          from: "media_asset",
          where: inList("asset_id", coverAssetIds).sql,
          bind: inList("asset_id", coverAssetIds).bind,
          order: {
            sortColumn: "asset_id",
            pkColumn: "asset_id",
            descending: false,
          },
        })
      : [];
    const assetById = new Map(
      assetsResult.map((a) => [a.asset_id, a] as const)
    );
    const contentIds = [
      ...new Set([...assetById.values()].map((a) => a.content_id)),
    ];
    const contentsResult = contentIds.length
      ? await readPages<RawContent>(ctx, {
          name: "photos.people.contents",
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
      contentsResult.map((c) => [c.content_id, c] as const)
    );

    const proposals = coverGroups.map(([key, group]) => {
      const asset = group.coverRegion.asset_id
        ? assetById.get(group.coverRegion.asset_id)
        : undefined;
      const content = asset ? contentById.get(asset.content_id) : undefined;
      const { src, thumb } = srcOf(content);
      return {
        cluster_id: key,
        party_id: group.partyId,
        count: group.assetIds.size,
        region_id: group.coverRegion.region_id,
        cover: asset
          ? {
              asset_id: asset.asset_id,
              content_uri: src,
              thumb_uri: thumb,
              width: asset.width ?? null,
              height: asset.height ?? null,
              bbox: safeParse(group.coverRegion.bbox_json),
            }
          : null,
      };
    });

    return {
      people: grouped.confirmed
        .filter((entry) => nameOf.has(entry.id))
        .map((entry) => ({
          party_id: entry.id,
          name: nameOf.get(entry.id) ?? null,
          count: entry.assetIds.length,
          asset_ids: entry.assetIds,
          // `null` for a non-person confirmer: the view says "someone else".
          confirmed_by: entry.confirmerIds.map((confirmerId) => ({
            party_id: confirmerId,
            name: nameOf.get(confirmerId) ?? null,
          })),
        })),
      proposals,
      // The pending count, not the groups above.
      unmatchedTotal: grouped.pendingTotal,
    };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code === "VAULT_ACCESS") {
      return {
        people: [],
        proposals: [],
        unmatchedTotal: 0,
        vaultDenied: { code: e.code, message: e.message },
      };
    }
    return {
      people: [],
      proposals: [],
      unmatchedTotal: 0,
      error: String(e.message ?? error),
    };
  }
}

function safeParse(json: unknown): unknown {
  try {
    return JSON.parse(String(json ?? "null"));
  } catch {
    return null;
  }
}
