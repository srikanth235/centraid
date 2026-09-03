import type { PhotoAsset } from "./timeline-model";

export interface ImportCandidate {
  id: string;
  localId: string;
  filename: string;
  kind: "photo" | "video";
}

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

export interface ImportProgress {
  done: readonly string[];
  imported: number;
  skipped: number;
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
      outcome = "failed";
      reason = error instanceof Error ? error.message : String(error);
    }
    current = recordOutcome(current, candidate.id, outcome, reason);
    deps.onProgress?.(current);
  }
  return current;
}

export function importSummary(progress: ImportProgress): string {
  const failedCount = Object.keys(progress.failed).length;
  const parts = [`${progress.imported} imported`];
  if (progress.skipped > 0) parts.push(`${progress.skipped} already in`);
  if (failedCount > 0) parts.push(`${failedCount} failed`);
  return parts.join(" · ");
}
