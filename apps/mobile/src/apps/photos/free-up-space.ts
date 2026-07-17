// The free-up-space eligibility predicate — the one action in Photos that
// deletes device originals, so it lives here as a pure, unit-tested module
// rather than inline JSX.
//
// Two gates, in order:
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

import type { BackupState, PhotoAsset } from './timeline-model';

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
  assets: readonly PhotoAsset[],
  protectedAssetIds: ReadonlySet<string>,
): FreeUpCandidate[] {
  return assets.flatMap((asset) => {
    const localIds = asset.localIds ?? (asset.localId ? [asset.localId] : []);
    const eligible =
      asset.assetId !== undefined &&
      asset.sha256 !== undefined &&
      asset.source === 'merged' &&
      asset.backupState === ('backed-up' satisfies BackupState) &&
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

/** Current bytes of one device copy, or `null` if the OS no longer has it. */
export type DeviceByteProbe = (localId: string) => Promise<{ sha256: string; size: number } | null>;

export interface RevalidationResult {
  /** Device copies whose current sha still equals the backed-up sha. */
  deletableLocalIds: string[];
  /** Reclaimable bytes across the deletable copies. */
  eligibleBytes: number;
  /** Copies whose bytes changed since backup — excluded to avoid data loss. */
  changedCount: number;
  /** Copies the OS could not read (already gone / permission) — excluded. */
  missingCount: number;
}

/**
 * Re-hash every candidate copy and partition into deletable vs. changed/missing.
 * The probe is injected so the predicate stays testable without native modules;
 * production wires it to a streaming SHA-256 over the current file bytes.
 */
export async function revalidateBackedUp(
  candidates: readonly FreeUpCandidate[],
  probe: DeviceByteProbe,
): Promise<RevalidationResult> {
  const deletableLocalIds: string[] = [];
  let eligibleBytes = 0;
  let changedCount = 0;
  let missingCount = 0;
  for (const candidate of candidates) {
    for (const localId of candidate.localIds) {
      let current: Awaited<ReturnType<DeviceByteProbe>>;
      try {
        current = await probe(localId);
      } catch {
        current = null;
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
  return { deletableLocalIds, eligibleBytes, changedCount, missingCount };
}
