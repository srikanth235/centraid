// Frame-wide, not a Photos feature (#712); `freeUpOffer` takes app ids from its
// CALLER, so exclusions stay structural. Delete-time re-hash is mandatory: a
// photo edited in place keeps its `ph://` id but holds new bytes.

/** Structural, not imported: `kit/` may not reach an app. */
export interface FreeUpAsset {
  assetId?: string;
  sha256?: string;
  /** `"merged"` — in a vault AND on this device. */
  source?: string;
  /** `"backed-up"` — proven remote custody. */
  backupState?: string;
  verifiedCasAck?: boolean;
  localId?: string;
  localIds?: string[];
  fileSize?: number;
}

export interface FreeUpCandidate {
  assetId: string;
  localIds: string[];
  sha256: string;
  fileSize: number;
}

export function selectFreeUpCandidates(
  assets: readonly FreeUpAsset[],
  protectedAssetIds: ReadonlySet<string>
): FreeUpCandidate[] {
  return assets.flatMap((asset) => {
    const localIds = asset.localIds ?? (asset.localId ? [asset.localId] : []);
    const eligible =
      asset.assetId !== undefined &&
      asset.sha256 !== undefined &&
      asset.source === "merged" &&
      asset.backupState === "backed-up" &&
      asset.verifiedCasAck === true &&
      localIds.length > 0 &&
      !protectedAssetIds.has(asset.assetId);
    return eligible
      ? [
          {
            assetId: asset.assetId!,
            localIds,
            sha256: asset.sha256!,
            fileSize: asset.fileSize ?? 0,
          },
        ]
      : [];
  });
}

/** `'in-cloud'` is not `null`: nothing was hashed, so no evidence. */
export type DeviceByteProbe = (
  localId: string
) => Promise<{ sha256: string; size: number } | "in-cloud" | null>;

export interface RevalidationResult {
  deletableLocalIds: string[];
  eligibleBytes: number;
  changedCount: number;
  missingCount: number;
  inCloudCount: number;
}

export async function revalidateBackedUp(
  candidates: readonly FreeUpCandidate[],
  probe: DeviceByteProbe
): Promise<RevalidationResult> {
  const deletableLocalIds: string[] = [];
  let eligibleBytes = 0;
  let changedCount = 0;
  let missingCount = 0;
  let inCloudCount = 0;
  const candidatesWithCopies = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      currentCopies: await Promise.all(
        candidate.localIds.map(async (localId) => {
          try {
            return { localId, current: await probe(localId) };
          } catch {
            return { localId, current: null };
          }
        })
      ),
    }))
  );
  for (const { candidate, currentCopies } of candidatesWithCopies) {
    for (const { localId, current } of currentCopies) {
      if (current === "in-cloud") {
        inCloudCount += 1;
        continue;
      }
      if (current === null) {
        missingCount += 1;
        continue;
      }
      if (current.sha256 === candidate.sha256) {
        deletableLocalIds.push(localId);
        eligibleBytes += current.size;
      } else {
        changedCount += 1;
      }
    }
  }
  return {
    deletableLocalIds,
    eligibleBytes,
    changedCount,
    missingCount,
    inCloudCount,
  };
}

export interface FreeUpTotals {
  count: number;
  bytes: number;
}

/** `uncounted` (nobody looked) is not `nothing` (looked, found none). */
export type FreeUpOffer =
  | { kind: "uncounted" }
  | { kind: "nothing" }
  | { kind: "offer"; totals: FreeUpTotals };

export function freeUpOffer(
  rollup: { computedAt: string | null; freeable: FreeUpTotals },
  appIds: readonly string[]
): FreeUpOffer {
  if (rollup.computedAt === null) return { kind: "uncounted" };
  if (appIds.length === 0) return { kind: "nothing" };
  if (rollup.freeable.count === 0 || rollup.freeable.bytes === 0)
    return { kind: "nothing" };
  return { kind: "offer", totals: rollup.freeable };
}

export const FREE_UP_CAUSE =
  "These originals are held on your gateway and on this machine at once. The rollup proved the remote copy, so the local one is a duplicate.";

export const FREE_UP_CONSEQUENCE =
  "Everything stays browsable — thumbnails and previews are untouched. Fetching a full-quality original back stays explicit: you ask for it, and it comes over the network under the transfer rules above.";

export const FREE_UP_ACTION = "Free up space";

export const FREE_UP_UNCOUNTED =
  "Not yet computed — your gateway's storage sweep has not run here.";

export const FREE_UP_NOTHING =
  "Nothing to free — every original here is the only proven copy, or already gone.";
