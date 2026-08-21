/** Shared face grouping and photograph-count law for every Photos seat. */
export interface CountableFaceRegion {
  region_id: string;
  asset_id?: string | null;
  party_id?: string | null;
  confirmed_by_party_id?: string | null;
  review_state?: string | null;
}

export interface CountableFaceCluster {
  region_id: string;
  cluster_id: string;
}

export interface FaceCountGroup {
  id: string;
  regionIds: string[];
  assetIds: string[];
  coverRegionId: string | null;
}

export interface ConfirmedFaceCountGroup extends FaceCountGroup {
  confirmerIds: string[];
}

export interface PeopleFaceGroups {
  confirmed: ConfirmedFaceCountGroup[];
  pendingByParty: FaceCountGroup[];
  unnamed: FaceCountGroup[];
  pendingTotal: number;
}

function groupRows(
  rows: readonly CountableFaceRegion[],
  idOf: (row: CountableFaceRegion) => string | null
): FaceCountGroup[] {
  const groups = new Map<string, CountableFaceRegion[]>();
  for (const row of rows) {
    const id = idOf(row);
    if (!id) continue;
    const bucket = groups.get(id);
    if (bucket) bucket.push(row);
    else groups.set(id, [row]);
  }
  return [...groups].map(([id, regions]) => {
    const ordered = [...regions].sort((a, b) =>
      a.region_id < b.region_id ? -1 : 1
    );
    const assetIds = [
      ...new Set(
        ordered
          .map((region) => region.asset_id)
          .filter((assetId): assetId is string => Boolean(assetId))
      ),
    ];
    return {
      id,
      regionIds: ordered.map((region) => region.region_id),
      assetIds,
      coverRegionId:
        ordered.find((region) => Boolean(region.asset_id))?.region_id ?? null,
    };
  });
}

/**
 * A person exists only after a confirmed answer. Counts are distinct
 * photographs, while proposed candidates and unnamed clusters remain
 * questions in separate collections.
 */
export function groupPeopleFaces(
  faces: readonly CountableFaceRegion[],
  clusters: readonly CountableFaceCluster[]
): PeopleFaceGroups {
  const confirmedRows = faces.filter(
    (face) => face.review_state === "confirmed" && Boolean(face.party_id)
  );
  const confirmed = groupRows(
    confirmedRows,
    (face) => face.party_id ?? null
  ).map((group) => ({
    ...group,
    confirmerIds: [
      ...new Set(
        confirmedRows
          .filter((face) => face.party_id === group.id)
          .map((face) => face.confirmed_by_party_id)
          .filter((id): id is string => Boolean(id))
      ),
    ].sort(),
  }));

  const proposed = faces.filter((face) => face.review_state === "proposed");
  const pendingByParty = groupRows(
    proposed.filter((face) => Boolean(face.party_id)),
    (face) => face.party_id ?? null
  );
  const clusterByRegion = new Map(
    clusters.map((cluster) => [cluster.region_id, cluster.cluster_id] as const)
  );
  const unnamed = groupRows(
    proposed.filter((face) => !face.party_id),
    (face) => clusterByRegion.get(face.region_id) ?? null
  );

  return { confirmed, pendingByParty, unnamed, pendingTotal: proposed.length };
}
