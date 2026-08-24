// Pure derivations for the Face review queue (issue #711), shared by
// FaceReview.tsx. Framework-free so the two rules it exists to hold are
// unit-testable without mounting a screen:
//
//   1. CONFIDENCE IS NEVER A PERCENTAGE (README.md:285). `matchCountFor`
//      answers "how many OTHER photographs propose the same person", not the
//      enricher's raw similarity score — the same derivation
//      packages/blueprints/apps/photos/queries/face-queue.ts uses for the web
//      surface, computed here from the replica's own rows instead of a vault
//      read (the two clients read the same table, `media.face_region`, so
//      the two derivations must agree).
//   2. ONE FACE AT A TIME (v4 3967). `buildQueue` returns an ORDERED list;
//      FaceReview.tsx is responsible for ever showing only `queue[cursor]`.
//
// `first seen` is a real gap, not an invented fact — see FaceReview.tsx's own
// header for why `media_face_region` cannot honestly say when a proposal was
// first made (no `created_at` column). This derives the closest true
// substitute: the earliest CAPTURE date among the matching photographs.
export interface FaceRegionRow {
  region_id: unknown;
  asset_id: unknown;
  party_id?: unknown;
  confidence?: unknown;
  confirmed_by_party_id?: unknown;
  bbox_json?: unknown;
  /** `proposed` | `confirmed` | `rejected` | `dismissed` (issue #712). */
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

/** Every UNANSWERED region, in a deterministic order (no timestamp exists to
 *  sort on, so region_id is the tiebreak — same choice the web query makes).
 *
 *  "Unanswered", not "unconfirmed" (issue #712): a rejected region — which
 *  is a remembered decision rather than a deleted row — and one the member
 *  deliberately left unnamed are both finished with. Filtering on
 *  `confirmed_by_party_id` alone would put every one of them back in front of
 *  the member on the next replica pull, which is the exact bug that made this
 *  queue impossible to empty. */
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
