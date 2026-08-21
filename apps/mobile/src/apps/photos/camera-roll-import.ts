// The first-run camera-roll import, as data (issue #724 A2).
//
// EVERYTHING ELSE THAT TOUCHES A CAMERA ROLL ON THIS SCREEN WRITES AD HOC.
// `useAutomaticPhotoBackup` (`photos-backup.ts`) and its manual twin
// `runBackup` both enqueue straight onto the native upload queue, which
// attaches the `photos / upload` action as its own follow-up the moment the
// bytes settle — there is no draft to review and no batch a member (or a
// support session) can inspect afterwards. That is the right shape for "a
// photo was just taken, send it" but the wrong one for "here are three
// thousand photographs nobody has looked at yet, offer to bring them in":
// the vault's own staging spine (`sync_import_batch`/`sync_import_row`,
// `ingest/stage-file.ts`) exists exactly for first contact with a pile of
// data nobody has reviewed, and Takeout already goes through it. This module
// is the mobile half of putting camera-roll import on the SAME spine —
// `camera-roll-import-run.ts` is the network half, calling the same
// `POST /centraid/_vault/imports` route a dropped Takeout zip does, one
// photograph (or Live Photo pair) at a time.
//
// WHY ONE PHOTO PER BATCH, NOT ONE BATCH OF THOUSANDS. The staging spine's
// bulk door, `sync.stage_rows`, batches up to 500 rows into one
// `sync_import_batch` — but it is reached only through the vault's command
// pipeline (harness/MCP callers, `commands/sync.ts`), which the mobile app has
// no HTTP door onto today, and adding one is out of this issue's scope. The
// file-drop route mobile CAN already reach stages exactly one file per call.
// That is less elegant (a full camera roll creates one `sync_connection` row
// per photo, since `stageFile` keys a connection on `(kind, filename)`) but
// it is not less CORRECT: per-row failure isolation becomes per-CALL failure
// isolation, which is the same property at a finer grain, and the vault's own
// sha256 dedupe (`mediaAssetPublisher.probe`, `ingest/publishers.ts`) makes
// "exactly-once creates on resume" a server-side guarantee regardless of how
// many times the mobile client restages the same bytes. Left for whoever
// picks this up next: a `sync.stage_rows`-backed HTTP route would let
// hundreds of photographs share one batch, the way Takeout's zip import does.
//
// THE BULK-WALK LAW, KEPT. `timeline-engine.ts`'s header is the law: no
// per-asset native round trips across a library the size of a phone's camera
// roll. Selecting candidates below reads nothing off the device at all — it
// filters the SAME `PhotoAsset[]` the timeline already walked in bulk
// (`timeline-engine.ts`'s `exeForMetadata()` page reads). The one per-asset
// native call this feature adds (`liveVideoUri`, in `camera-roll-import-run.ts`)
// happens only for a photograph already being opened to read its bytes for
// upload — a crossing that has to happen once per imported asset regardless,
// never a separate bulk scan of the whole roll to find out which ones are
// Live Photos first.
//
// LIVE PHOTO PAIRING, HONESTLY BOUNDED. `expo-media-library`'s bulk metadata
// (`AssetMetadata`, read by the timeline's own page walk) carries no
// `mediaSubtypes` field — Live Photo membership is knowable only per asset,
// through `Asset.getLivePhotoVideoUri()` (`device-media.ts`'s `liveVideoUri`,
// already used the same way by `photos-backup.ts`'s manual/automatic sweep).
// So pairing here costs exactly one extra native call per photograph actually
// being imported — never a 50k-asset pre-scan to find out which ones qualify.
// A capture group is assigned with the SAME `live:<localId>` convention
// `photos-backup.ts` already uses, so a photograph backed up through either
// path lands in the same group.

import type { PhotoAsset } from "./timeline-model";

/** A camera-roll photograph this run has not yet finished with. Carries only
 *  what `camera-roll-import-run.ts` needs to open and stage it — never the
 *  whole `PhotoAsset`, so this module stays provable without a live device. */
export interface ImportCandidate {
  /** The timeline row's own id — stable across a kill and relaunch, and what
   *  progress is keyed by (never the localId alone: a merged row's localId
   *  can be one of several `localIds`, but its `id` is singular). */
  id: string;
  localId: string;
  filename: string;
  kind: "photo" | "video";
}

/**
 * Which camera-roll photographs a first-run offer would import: on THIS
 * device and nowhere else, right now. The same predicate
 * `automaticBackupCandidates` (`photos-backup.ts`) applies to its own sweep —
 * restated here rather than imported so this module stays free of that
 * file's React import, and because the two candidate sets are allowed to
 * diverge later (a first-run OFFER and a background SWEEP are different
 * decisions that happen to share one filter today).
 */
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

/** One candidate's fate, once its stage-and-publish call has settled. */
export type ImportOutcome = "imported" | "skipped" | "failed";

/** The run's state — PERSISTED (as plain JSON) between launches, so a kill
 *  mid-import resumes past whatever already finished rather than restarting
 *  the whole roll. `done` is the resumability boundary: a candidate in it is
 *  never attempted again, imported, skipped or failed alike. */
export interface ImportProgress {
  /** Candidate ids this run has finished with, in any outcome. */
  done: readonly string[];
  imported: number;
  skipped: number;
  /** Candidate id → the failure's own sentence. Kept, not just counted, so a
   *  member (or a support session) can see WHICH photographs did not come in
   *  and why — a count alone would be an honest number about a dishonest
   *  silence. */
  failed: Readonly<Record<string, string>>;
}

export const EMPTY_IMPORT_PROGRESS: ImportProgress = {
  done: [],
  imported: 0,
  skipped: 0,
  failed: {},
};

/** Candidates this run has not finished with yet — what a resumed run, or the
 *  progress readout, actually has left to do. */
export function remainingCandidates(
  candidates: readonly ImportCandidate[],
  progress: ImportProgress
): ImportCandidate[] {
  const done = new Set(progress.done);
  return candidates.filter((candidate) => !done.has(candidate.id));
}

/** Fold one candidate's settled outcome into the run's progress. Pure: the
 *  caller decides what "settled" means (a network call, a fake in a test) and
 *  hands the verdict here to be recorded exactly once. */
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
 * Run every remaining candidate through `attempt`, SERIALLY (one HTTP round
 * trip's worth of stage-then-publish at a time, the same discipline
 * `runTransfers` and `addToAlbum`'s serial write loop already hold elsewhere
 * in this app) and to completion — a rejection is caught and recorded as
 * `failed` rather than aborting the run, which is PER-CANDIDATE failure
 * isolation: one photograph's stage-or-publish throwing never costs the rest
 * of the roll its turn.
 *
 * RESUMABLE BY CONSTRUCTION, not by a checkpoint file: `progress` is folded
 * forward one candidate at a time and handed to `onProgress` after every
 * single one, so a caller that persists it (durable storage, or simply a kill
 * of the whole process) can call this again later with EXACTLY the record it
 * last saw and resume from there — `remainingCandidates` guarantees nothing
 * already in `done` is attempted twice, however many times the app relaunches
 * mid-roll. Exactly-once CREATION is additionally guaranteed at the vault
 * layer regardless (`mediaAssetPublisher.probe` dedupes by sha256), so a
 * caller that skipped persisting progress and restaged an already-imported
 * photograph would still not create a second asset for it — this loop's own
 * bookkeeping is what makes resuming CHEAP, not what makes it CORRECT.
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
      // The recovery IS the feature: per-candidate failure isolation means
      // one photograph's stage-or-publish throwing is recorded and the run
      // moves on, exactly as `applyBatchTx` isolates one row's publish
      // failure from the rest of its batch (`ingest/staging.ts`).
      outcome = "failed";
      reason = error instanceof Error ? error.message : String(error);
    }
    current = recordOutcome(current, candidate.id, outcome, reason);
    deps.onProgress?.(current);
  }
  return current;
}

/** The offer's own summary line, once a run has finished or paused — honest
 *  counts, never a spinner (§18), and the failure count named rather than
 *  folded silently into "skipped". */
export function importSummary(progress: ImportProgress): string {
  const failedCount = Object.keys(progress.failed).length;
  const parts = [`${progress.imported} imported`];
  if (progress.skipped > 0) parts.push(`${progress.skipped} already in`);
  if (failedCount > 0) parts.push(`${failedCount} failed`);
  return parts.join(" · ");
}
