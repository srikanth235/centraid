// First-run camera-roll import, as data (#724).
//
// Rides the vault's STAGING SPINE (`POST /centraid/_vault/imports`, the route a
// Takeout zip uses), not the ad-hoc upload queue `photos-backup.ts` writes to:
// an unreviewed pile needs an inspectable batch. That route stages ONE file per
// call — the bulk `sync.stage_rows` door has no HTTP entry for mobile — which
// is per-call failure isolation, with `mediaAssetPublisher.probe`'s sha256
// dedupe keeping creates exactly-once on resume.
//
// The bulk-walk law (`timeline-engine.ts`) holds: selection reads nothing off
// the device, and Live Photo pairing costs one native call per photograph
// ACTUALLY imported, never a pre-scan. Capture groups use `photos-backup.ts`'s
// `live:<localId>` convention.
import type { PhotoAsset } from "./timeline-model";

/** Not the whole `PhotoAsset`: this module stays provable without a device. */
export interface ImportCandidate {
  /** What progress is keyed by — never the localId, which a merged row can
   *  have several of. */
  id: string;
  localId: string;
  filename: string;
  kind: "photo" | "video";
}

/** `automaticBackupCandidates` shares this predicate but is deliberately not
 *  imported: it pulls React in, and OFFER may diverge from SWEEP later. */
export function selectImportCandidates(
  assets: readonly PhotoAsset[]
): ImportCandidate[] {
  return assets.flatMap((asset) =>
    asset.backupState === "local-only" && asset.localId
      ? [
          {
            id: asset.id,
            localId: asset.localId,
            filename: asset.filename ?? asset.id,
            kind: asset.kind === "video" ? "video" : "photo",
          },
        ]
      : []
  );
}

export type ImportOutcome = "imported" | "skipped" | "failed";

/** Persisted as plain JSON between launches so a kill mid-import resumes. */
export interface ImportProgress {
  /** The resumability boundary: an id here is never attempted again, whatever
   *  its outcome was. */
  done: readonly string[];
  imported: number;
  skipped: number;
  /** Candidate id → its failure sentence: a count alone is an honest number
   *  about a dishonest silence. */
  failed: Readonly<Record<string, string>>;
}

export const EMPTY_IMPORT_PROGRESS: ImportProgress = {
  done: [],
  imported: 0,
  skipped: 0,
  failed: {},
};

export function remainingCandidates(
  candidates: readonly ImportCandidate[],
  progress: ImportProgress
): ImportCandidate[] {
  const done = new Set(progress.done);
  return candidates.filter((candidate) => !done.has(candidate.id));
}

export function recordOutcome(
  progress: ImportProgress,
  candidateId: string,
  outcome: ImportOutcome,
  reason?: string
): ImportProgress {
  return {
    done: [...progress.done, candidateId],
    imported: progress.imported + (outcome === "imported" ? 1 : 0),
    skipped: progress.skipped + (outcome === "skipped" ? 1 : 0),
    failed:
      outcome === "failed"
        ? { ...progress.failed, [candidateId]: reason ?? "unknown error" }
        : progress.failed,
  };
}

/**
 * SERIAL by contract, and run to completion: a rejection is recorded as
 * `failed` rather than aborting, so one photograph never costs the rest of the
 * roll its turn.
 *
 * RESUMABLE BY CONSTRUCTION, not by a checkpoint file: `progress` is handed to
 * `onProgress` after every candidate, so a caller can persist it and call this
 * again with exactly the record it last saw. This bookkeeping makes resuming
 * cheap, not correct — exactly-once creation is the vault's sha256 dedupe.
 */
export async function runCameraRollImport(
  candidates: readonly ImportCandidate[],
  progress: ImportProgress,
  deps: {
    attempt: (candidate: ImportCandidate) => Promise<ImportOutcome>;
    onProgress?: (progress: ImportProgress) => void;
  }
): Promise<ImportProgress> {
  let current = progress;
  for (const candidate of remainingCandidates(candidates, current)) {
    let outcome: ImportOutcome;
    let reason: string | undefined;
    try {
      // oxlint-disable-next-line no-await-in-loop -- serial by contract, see above.
      outcome = await deps.attempt(candidate);
    } catch (error) {
      // The recovery IS the feature: record and move on, as `applyBatchTx`
      // isolates one row's publish failure from its batch.
      outcome = "failed";
      reason = error instanceof Error ? error.message : String(error);
    }
    current = recordOutcome(current, candidate.id, outcome, reason);
    deps.onProgress?.(current);
  }
  return current;
}

/** Honest counts, never a spinner (§18); failures are named, not folded into
 *  "skipped". */
export function importSummary(progress: ImportProgress): string {
  const failedCount = Object.keys(progress.failed).length;
  const parts = [`${progress.imported} imported`];
  if (progress.skipped > 0) parts.push(`${progress.skipped} already in`);
  if (failedCount > 0) parts.push(`${failedCount} failed`);
  return parts.join(" · ");
}
