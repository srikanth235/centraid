import { groupPeopleFaces } from "../../_shared/people-counts.ts";
import { srcOf } from "./_shared.ts";

interface RawRegion {
  region_id: string;
  asset_id?: string | null;
  bbox_json?: unknown;
  party_id?: string | null;
  confirmed_by_party_id?: string | null;
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

const REGION_LIMIT = 4000;

const PROPOSAL_LIMIT = 60;

interface ProposalGroup {
  partyId: string | null;
  assetIds: Set<string>;
  coverRegion: RawRegion;
}

export default async function people({ ctx }: HandlerArgs) {
  const purpose = "dpv:ServiceProvision";
  try {
    const [regionsResult, partiesResult, clustersResult] = await Promise.all([
      ctx.vault.read({
        entity: "media.face_region",
        limit: REGION_LIMIT,
        purpose,
      }),
      ctx.vault.read({
        entity: "core.party",
        orderBy: { column: "display_name", dir: "asc" },
        limit: 500,
        purpose,
      }),
      ctx.vault.read({
        entity: "media.face_cluster",
        limit: REGION_LIMIT,
        purpose,
      }),
    ]);
    const regions = (regionsResult.rows ?? []) as unknown as RawRegion[];
    const clusters = (clustersResult.rows ?? []) as unknown as RawCluster[];
    const nameOf = new Map(
      ((partiesResult.rows ?? []) as unknown as RawParty[])
        .filter((party) => party.kind === "person")
        .map((party) => [party.party_id, party.display_name] as const)
    );

    const grouped = groupPeopleFaces(regions, clusters);
    const regionById = new Map(
      regions.map((region) => [region.region_id, region] as const)
    );

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
      ? await ctx.vault.read({
          entity: "media.asset",
          where: [{ column: "asset_id", op: "in", value: coverAssetIds }],
          limit: coverAssetIds.length,
          purpose,
        })
      : { rows: [] };
    const assetById = new Map(
      ((assetsResult.rows ?? []) as unknown as RawAsset[]).map(
        (a) => [a.asset_id, a] as const
      )
    );
    const contentIds = [
      ...new Set([...assetById.values()].map((a) => a.content_id)),
    ];
    const contentsResult = contentIds.length
      ? await ctx.vault.read({
          entity: "core.content_item",
          where: [{ column: "content_id", op: "in", value: contentIds }],
          purpose,
        })
      : { rows: [] };
    const contentById = new Map(
      ((contentsResult.rows ?? []) as unknown as RawContent[]).map(
        (c) => [c.content_id, c] as const
      )
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
          confirmed_by: entry.confirmerIds.map((confirmerId) => ({
            party_id: confirmerId,
            name: nameOf.get(confirmerId) ?? null,
          })),
        })),
      proposals,
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
