// First-run camera-roll import as data (#724): vault staging spine, sha256 dedupe.
import type { PhotoAsset } from "./timeline-model";

/** One sentence for a file the import could not take (#1015, S14 — R-A-15).
 *  What the attempt throws is an HTTP status or a media-library errno. */
const IMPORT_NOT_LANDED = "This one did not import.";

export interface ImportCandidate {
  /** Never the localId. */
  id: string;
  localId: string;
  filename: string;
  kind: "photo" | "video";
  /** Carried into the canonical write, exactly as the backup sweep does. */
  capturedAt?: string;
  width?: number;
  height?: number;
  durationS?: number;
}

/** Do not import `automaticBackupCandidates`: it pulls React in. */
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
            ...(asset.capturedAt ? { capturedAt: asset.capturedAt } : {}),
            ...(asset.width === undefined ? {} : { width: asset.width }),
            ...(asset.height === undefined ? {} : { height: asset.height }),
            ...(asset.durationS === undefined
              ? {}
              : { durationS: asset.durationS }),
          },
        ]
      : []
  );
}

export type ImportOutcome = "imported" | "skipped" | "failed";

export interface ImportProgress {
  /**
   * Candidates that reached the vault. A FAILURE is deliberately absent
   * (#1014, R8): an id here was never offered again, so one refused
   * photograph was silently written off for the life of the install.
   */
  done: readonly string[];
  imported: number;
  skipped: number;
  /** Candidate id → failure sentence. */
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
  if (outcome === "failed") {
    return {
      // NOT done (#1014, R8): the candidate stays offered, with its reason,
      // and the next Import is its retry.
      done: progress.done,
      imported: progress.imported,
      skipped: progress.skipped,
      failed: { ...progress.failed, [candidateId]: reason ?? "unknown error" },
    };
  }
  // A candidate that succeeded on the retry stops being a failure.
  const failed = { ...progress.failed };
  delete failed[candidateId];
  return {
    done: [...progress.done, candidateId],
    imported: progress.imported + (outcome === "imported" ? 1 : 0),
    skipped: progress.skipped + (outcome === "skipped" ? 1 : 0),
    failed,
  };
}

/**
 * Forget ids the roll no longer holds (#1014, P19).
 *
 * `done` was an append-only array persisted in full after EVERY candidate, so
 * a 50,000-photograph import wrote a list that ended 50,000 entries long,
 * 50,000 times, and then carried it forever — including entries for
 * photographs the member had since deleted from the device.
 */
export function pruneProgress(
  progress: ImportProgress,
  candidates: readonly ImportCandidate[],
  known: ReadonlySet<string>
): ImportProgress {
  const live = new Set([
    ...candidates.map((candidate) => candidate.id),
    ...known,
  ]);
  const done = progress.done.filter((id) => live.has(id));
  const failed = Object.fromEntries(
    Object.entries(progress.failed).filter(([id]) => live.has(id))
  );
  if (
    done.length === progress.done.length &&
    Object.keys(failed).length === Object.keys(progress.failed).length
  ) {
    return progress;
  }
  return { ...progress, done, failed };
}

/** SERIAL: rejections recorded as `failed`, never abort; resumable via `onProgress`. */
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
      // Record and move on. The exception goes to the log (S14, #1015,
      // R-A-15); the row that failed says so in the member's own words.
      console.warn("[photos] import candidate failed", candidate.id, error);
      outcome = "failed";
      reason = IMPORT_NOT_LANDED;
    }
    current = recordOutcome(current, candidate.id, outcome, reason);
    deps.onProgress?.(current);
  }
  return current;
}

/** Honest counts (§18); failures named. */
export function importSummary(progress: ImportProgress): string {
  const failedCount = Object.keys(progress.failed).length;
  const parts = [`${progress.imported} imported`];
  if (progress.skipped > 0) parts.push(`${progress.skipped} already in`);
  if (failedCount > 0) parts.push(`${failedCount} failed`);
  return parts.join(" · ");
}

/**
 * THE BATCH, WITH THE SEAT NUDGED ONCE AT THE END (#1011 M2).
 *
 * The canonical writes go through this phone's own session (#1014, R20), so
 * their rows land locally the moment each write is admitted. The nudge stays
 * for the gateway-side rows the publisher derives from them — recognition,
 * capture groups: ONE per batch, and none at all when nothing was imported,
 * because then there is no new row to come and fetch. Not a poll; the ordinary
 * catch-up paths are untouched.
 */
export async function runImportBatch(
  candidates: readonly ImportCandidate[],
  progress: ImportProgress,
  deps: {
    attempt: (candidate: ImportCandidate) => Promise<ImportOutcome>;
    nudgeSeat: () => void | Promise<unknown>;
    onProgress?: (progress: ImportProgress) => void;
  }
): Promise<ImportProgress> {
  const result = await runCameraRollImport(candidates, progress, {
    attempt: deps.attempt,
    ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
  });
  if (result.imported > progress.imported) await deps.nudgeSeat();
  return result;
}
