// FREE UP SPACE IS A FRAME CAPABILITY, NOT A PHOTOS FEATURE (#712).
//
// Nothing in it is about photographs: it decides whether a locally-resident original may be released
// because a copy is provably held somewhere else, which is the same question
// for a scan, an attachment, or anything else with bytes on this device.
// docs/blueprint-seats.md's seat table already says so — "Free up space" is a
// core feature for the byte-bearing seat and MEANINGLESS for record-only apps.
//
// TWO APPS ARE EXCLUDED STRUCTURALLY, AND NOT BY A FILTER IN HERE. Locker is
// excluded because the bytes ARE the secret — there is no lower-fidelity copy
// to fall back to, so "release the original and refetch on demand" is not a
// degradation, it is a loss of the thing. Record-only apps are excluded because
// they hold no originals at all. Neither exclusion is expressed as a name in
// this file: `freeUpOffer` takes the participating app ids from its CALLER and
// enumerates nothing itself, so an app cannot be quietly opted in by a list
// nobody reviews. An empty list is a real answer — no offer.
//
// The DEVICE-SIDE deletion flow is two gates, in order:
//
//   1. Compile-time (`selectFreeUpCandidates`): the asset is verifiably backed
//      up (a `merged` row whose remote CAS is `replicated`), is not pinned to a
//      keep-originals album, and still points at device bytes.
//
//   2. Delete-time (`revalidateBackedUp`): re-stat and re-hash the *current*
//      bytes of every device copy and keep only the ones whose sha still equals
//      the sha we backed up. A photo edited in place after backup keeps the same
//      `ph://` id but holds new bytes; deleting it there would destroy the only
//      copy of the edit. Anything that changed is excluded and surfaced.

/**
 * What a free-up pass needs to know about one item. Declared STRUCTURALLY
 * rather than imported: `kit/` may not reach into an app
 * (`scripts/check-import-boundaries.ts`), and Photos' `PhotoAsset` satisfies
 * this shape without either module knowing about the other.
 */
export interface FreeUpAsset {
  assetId?: string;
  sha256?: string;
  /** `"merged"` — present in a vault AND on this device. */
  source?: string;
  /** `"backed-up"` — the app's own name for proven remote custody. */
  backupState?: string;
  verifiedCasAck?: boolean;
  localId?: string;
  localIds?: string[];
  fileSize?: number;
}

export interface FreeUpCandidate {
  assetId: string;
  /** Every camera-roll copy that folded onto this backed-up sha. */
  localIds: string[];
  /** The sha we verified as replicated; delete-time bytes must still match it. */
  sha256: string;
  /** Best-effort reclaimable bytes for the pre-delete summary. */
  fileSize: number;
}

/**
 * Pure predicate over the merged timeline. Excludes anything not proven backed
 * up and anything pinned to a protected album. Does not touch the device.
 */
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

/**
 * Current bytes of one device copy: `null` if the OS no longer has it, or the
 * literal `'in-cloud'` when the original is in iCloud and was never downloaded
 * here. The two are reported apart because "already gone" and "still in the
 * cloud" are different sentences to tell the user — and the second one is not
 * evidence of anything about the bytes.
 */
export type DeviceByteProbe = (
  localId: string
) => Promise<{ sha256: string; size: number } | "in-cloud" | null>;

export interface RevalidationResult {
  /** Device copies whose current sha still equals the backed-up sha. */
  deletableLocalIds: string[];
  /** Reclaimable bytes across the deletable copies. */
  eligibleBytes: number;
  /** Copies whose bytes changed since backup — excluded to avoid data loss. */
  changedCount: number;
  /** Copies the OS could not read (already gone / permission) — excluded. */
  missingCount: number;
  /** Copies whose original is in iCloud, so nothing could be re-hashed. */
  inCloudCount: number;
}

/**
 * Re-hash every candidate copy and partition into deletable vs. changed/missing.
 * The probe is injected so the predicate stays testable without native modules;
 * production wires it to a streaming SHA-256 over the current file bytes.
 */
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

// ── The OFFER, over the gateway's rollup (B3) ──────────────────────────────

export interface FreeUpTotals {
  count: number;
  bytes: number;
}

/**
 * Whether the frame may offer to free space, and why not when it may not.
 *
 * Three answers, and the difference between the first two is the whole point:
 * `uncounted` means nobody has looked (the standing blob sweep has never
 * rebuilt the rollup), `nothing` means somebody looked and found nothing to
 * release. Rendering zeroes for the first says "you have nothing" when the
 * truth is "nothing has been counted".
 */
export type FreeUpOffer =
  | { kind: "uncounted" }
  | { kind: "nothing" }
  | { kind: "offer"; totals: FreeUpTotals };

/**
 * @param rollup The gateway's custody projection, as `storage/status` carries
 *   it. `computedAt === null` is the unrun sweep.
 * @param appIds The apps whose originals this offer covers. The CALLER owns
 *   this list (see the header): an empty one yields no offer, because an offer
 *   that names nothing releases nothing.
 */
export function freeUpOffer(
  rollup: { computedAt: string | null; freeable: FreeUpTotals },
  appIds: readonly string[]
): FreeUpOffer {
  if (rollup.computedAt === null) return { kind: "uncounted" };
  if (appIds.length === 0) return { kind: "nothing" };
  // A zero-byte `freeable` count is not an offer either — there is nothing to
  // describe, and an offer to free nothing is a control with no effect. Same
  // rule the web's `freeUpIsOfferable` applies to the same bucket.
  if (rollup.freeable.count === 0 || rollup.freeable.bytes === 0)
    return { kind: "nothing" };
  return { kind: "offer", totals: rollup.freeable };
}

/** The cause: what these bytes are, in one line. */
export const FREE_UP_CAUSE =
  "These originals are held on your gateway and on this machine at once. The rollup proved the remote copy, so the local one is a duplicate.";

/**
 * The consequence, stated before the action and not after it: what remains
 * browsable, and that getting an original back is an explicit act — never a
 * silent re-download on a metered connection.
 */
export const FREE_UP_CONSEQUENCE =
  "Everything stays browsable — thumbnails and previews are untouched. Fetching a full-quality original back stays explicit: you ask for it, and it comes over the network under the transfer rules above.";

/** The one action. Never filled — the commit on this surface is Back up now. */
export const FREE_UP_ACTION = "Free up space";

/** What the surface says when the sweep has never run. Not zeroes. */
export const FREE_UP_UNCOUNTED =
  "Not yet computed — your gateway's storage sweep has not run here.";

/** …and when it has run and found nothing releasable. */
export const FREE_UP_NOTHING =
  "Nothing to free — every original here is the only proven copy, or already gone.";
