// The first-run camera-roll import's batching/resume logic (#724).
//
// The vault-side publisher is untouched here — `mediaAssetPublisher`
// (`packages/vault/src/ingest/publishers.ts`) already carries its own
// resumability proof in the `takeout-photos.test.ts` mold (kill-mid-publish,
// re-import skips every already-published row). What this file proves is the
// MOBILE half: that a kill mid-import, modelled as persisted `ImportProgress`
// handed back into a fresh call, resumes past everything already finished —
// exactly once each, with per-candidate failures isolated rather than
// aborting the run — without needing a live device or a live vault.

import { describe, expect, test, vi } from "vitest";

import {
  EMPTY_IMPORT_PROGRESS,
  importSummary,
  recordOutcome,
  remainingCandidates,
  runCameraRollImport,
  selectImportCandidates,
} from "./camera-roll-import";
import type { ImportCandidate, ImportProgress } from "./camera-roll-import";
import type { PhotoAsset } from "./timeline-model";

function asset(overrides: Partial<PhotoAsset> & { id: string }): PhotoAsset {
  return {
    archived: false,
    backupState: "local-only",
    deleted: false,
    favorite: false,
    kind: "photo",
    localId: `local-${overrides.id}`,
    originalUri: `ph://${overrides.id}`,
    previewUri: `ph://${overrides.id}`,
    source: "device",
    uri: `ph://${overrides.id}`,
    ...overrides,
  };
}

function candidate(
  id: string,
  overrides: Partial<ImportCandidate> = {}
): ImportCandidate {
  return {
    filename: `${id}.jpg`,
    id,
    kind: "photo",
    localId: `local-${id}`,
    ...overrides,
  };
}

describe("selecting candidates", () => {
  test("only local-only photographs with a device identity are offered", () => {
    const assets = [
      asset({ id: "a", backupState: "local-only" }),
      asset({ id: "b", backupState: "backed-up" }),
      asset({ id: "c", backupState: "local-only", localId: undefined }),
      asset({ id: "d", backupState: "remote-only" }),
    ];
    expect(selectImportCandidates(assets).map((c) => c.id)).toStrictEqual([
      "a",
    ]);
  });

  test("carries the video kind through, not just photo", () => {
    const [candidateAsset] = selectImportCandidates([
      asset({ id: "v", kind: "video" }),
    ]);
    expect(candidateAsset?.kind).toBe("video");
  });
});

describe("progress bookkeeping", () => {
  test("an outcome is folded in exactly once and counted honestly", () => {
    let progress = EMPTY_IMPORT_PROGRESS;
    progress = recordOutcome(progress, "a", "imported");
    progress = recordOutcome(progress, "b", "skipped");
    progress = recordOutcome(progress, "c", "failed", "network unreachable");
    expect(progress).toStrictEqual({
      done: ["a", "b", "c"],
      imported: 1,
      skipped: 1,
      failed: { c: "network unreachable" },
    });
  });

  test("remaining candidates excludes everything already done", () => {
    const candidates = [candidate("a"), candidate("b"), candidate("c")];
    const progress: ImportProgress = {
      ...EMPTY_IMPORT_PROGRESS,
      done: ["a", "c"],
    };
    expect(
      remainingCandidates(candidates, progress).map((c) => c.id)
    ).toStrictEqual(["b"]);
  });

  test("the summary line names imported, skipped and failed honestly", () => {
    expect(
      importSummary({
        done: ["a", "b", "c"],
        imported: 1,
        skipped: 1,
        failed: { c: "boom" },
      })
    ).toBe("1 imported · 1 already in · 1 failed");
    expect(importSummary(EMPTY_IMPORT_PROGRESS)).toBe("0 imported");
  });
});

describe("resumable import run", () => {
  const candidates = [candidate("a"), candidate("b"), candidate("c")];

  test("a clean run attempts every candidate exactly once", async () => {
    const attempt = vi.fn<() => Promise<"imported">>(
      async () => "imported" as const
    );
    const progress = await runCameraRollImport(
      candidates,
      EMPTY_IMPORT_PROGRESS,
      {
        attempt,
      }
    );
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(progress.imported).toBe(3);
    expect([...progress.done].sort()).toStrictEqual(["a", "b", "c"]);
  });

  test("a kill mid-run, resumed, never re-attempts an already-done candidate", async () => {
    // Model the kill: only "a" finished before the process died, and its
    // outcome was PERSISTED (the whole point of `ImportProgress` being plain,
    // serialisable state rather than in-memory-only).
    const afterKill: ImportProgress = recordOutcome(
      EMPTY_IMPORT_PROGRESS,
      "a",
      "imported"
    );
    const attempt = vi.fn<
      (c: ImportCandidate) => Promise<"imported" | "skipped">
    >(async (c) => (c.id === "a" ? "imported" : ("skipped" as const)));
    const resumed = await runCameraRollImport(candidates, afterKill, {
      attempt,
    });
    // "a" is never attempted again — only "b" and "c", the genuine remainder.
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt.mock.calls.map(([c]) => c.id).sort()).toStrictEqual([
      "b",
      "c",
    ]);
    expect(resumed.imported).toBe(1);
    expect(resumed.skipped).toBe(2);
    expect([...resumed.done].sort()).toStrictEqual(["a", "b", "c"]);
  });

  test("calling resume again once everything is done attempts nothing at all", async () => {
    const attempt = vi.fn<() => Promise<"imported">>(
      async () => "imported" as const
    );
    const finished = await runCameraRollImport(
      candidates,
      EMPTY_IMPORT_PROGRESS,
      {
        attempt,
      }
    );
    attempt.mockClear();
    const resumedAgain = await runCameraRollImport(candidates, finished, {
      attempt,
    });
    expect(attempt).not.toHaveBeenCalled();
    expect(resumedAgain).toStrictEqual(finished);
  });

  test("one candidate's rejection is isolated — the rest of the run still lands", async () => {
    const attempt = vi.fn<(c: ImportCandidate) => Promise<"imported">>(
      async (c) => {
        if (c.id === "b") throw new Error("stage failed: 500");
        return "imported" as const;
      }
    );
    const progress = await runCameraRollImport(
      candidates,
      EMPTY_IMPORT_PROGRESS,
      {
        attempt,
      }
    );
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(progress.imported).toBe(2);
    expect(progress.failed).toStrictEqual({ b: "stage failed: 500" });
    // The failed candidate is DONE — a resumed run does not retry it forever
    // on its own; a member (or a future retry affordance) decides that.
    expect([...progress.done].sort()).toStrictEqual(["a", "b", "c"]);
  });

  test("progress is reported after every candidate, not only at the end", async () => {
    const seen: number[] = [];
    await runCameraRollImport(candidates, EMPTY_IMPORT_PROGRESS, {
      attempt: async () => "imported" as const,
      onProgress: (p) => seen.push(p.done.length),
    });
    expect(seen).toStrictEqual([1, 2, 3]);
  });
});
