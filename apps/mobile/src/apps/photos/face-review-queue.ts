// Pure derivations for the Face review queue (#711), shared by FaceReview.tsx;
// framework-free so its two rules stay unit-testable:
//   1. CONFIDENCE IS NEVER A PERCENTAGE (README.md:285): matchCountFor answers
//      "how many OTHER photographs propose the same person" — same derivation
//      as queries/face-queue.ts over the same table; the two must agree.
//   2. ONE FACE AT A TIME (v4 3967): buildQueue returns an ORDERED list;
//      FaceReview.tsx shows only queue[cursor].
//
// firstSeenAt: no created_at column exists (see FaceReview.tsx); earliest
// CAPTURE date among matching photographs is the closest true substitute.
export interface FaceRegionRow {
  region_id: unknown;
  asset_id: unknown;
  party_id?: unknown;
  confidence?: unknown;
  confirmed_by_party_id?: unknown;
  bbox_json?: unknown;
  /** `proposed` | `confirmed` | `rejected` | `dismissed` (#712). */
  review_state?: unknown;
}

export interface AssetRow {
  asset_id: unknown;
  captured_at?: unknown;
  width?: unknown;
  height?: unknown;
}

export interface QueueEntry {
  regionId: string;
  assetId: string;
  partyId: string | null;
  matchCount: number;
  firstSeenAt: string | null;
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

/** Every UNANSWERED region, region_id order (no timestamp to sort on; same
 *  as the web query). "Unanswered", not "unconfirmed" (#712): rejected and
 *  deliberately-unnamed regions are finished with — filtering on
 *  confirmed_by_party_id resurrects them every pull (the unemptyable-queue bug). */
export function buildQueue(
  faceRows: readonly FaceRegionRow[],
  assetRows: readonly AssetRow[]
): QueueEntry[] {
  const assetById = new Map(
    assetRows.map((a) => [str(a.asset_id), a] as const)
  );
  const assetIdsByParty = new Map<string, Set<string>>();
  for (const row of faceRows) {
    const partyId = row.party_id;
    if (partyId == null) continue;
    const key = str(partyId);
    const assetId = str(row.asset_id);
    if (!assetIdsByParty.has(key)) assetIdsByParty.set(key, new Set());
    assetIdsByParty.get(key)!.add(assetId);
  }

  function matchCountFor(row: FaceRegionRow): number {
    if (row.party_id == null) return 0;
    const ids = assetIdsByParty.get(str(row.party_id));
    if (!ids) return 0;
    const own = str(row.asset_id);
    return ids.has(own) ? ids.size - 1 : ids.size;
  }

  function firstSeenAtFor(row: FaceRegionRow): string | null {
    const ids =
      row.party_id == null
        ? [str(row.asset_id)]
        : [...(assetIdsByParty.get(str(row.party_id)) ?? [str(row.asset_id)])];
    let earliest: string | null = null;
    for (const id of ids) {
      const capturedAt = assetById.get(id)?.captured_at;
      const iso = capturedAt == null ? null : String(capturedAt);
      if (iso && (!earliest || iso < earliest)) earliest = iso;
    }
    return earliest;
  }

  return faceRows
    .filter((row) => row.review_state === "proposed")
    .map((row) => ({
      regionId: str(row.region_id),
      assetId: str(row.asset_id),
      partyId: row.party_id == null ? null : str(row.party_id),
      matchCount: matchCountFor(row),
      firstSeenAt: firstSeenAtFor(row),
    }))
    .sort((a, b) => (a.regionId < b.regionId ? -1 : 1));
}
