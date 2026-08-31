import { defineConfig } from "vitest/config";

import {
  coverageExclude,
  coverageInclude,
  coverageProjects,
} from "./vitest.config";

// #892 Phase 1 — the SHARD half of the split coverage lane.
//
// `bun run coverage` was 20m15s of a 26m34s `verify` job — roughly 77% of PR
// feedback latency — because one runner instrumented and ran the entire repo.
// This config is what each shard runner uses; `vitest --mergeReports` then
// reassembles the blobs under the ROOT config, which is where the floors live.
//
// THE ONE DIFFERENCE FROM THE ROOT CONFIG IS THE ABSENCE OF `thresholds`, AND IT
// IS LOAD-BEARING. A shard sees only its slice of the test universe, so every
// floor in tests/coverage-floors.json would fail against it — `packages/cli/**`
// measures 0% on the shard that happens to hold no CLI tests. Evaluating floors
// per shard would therefore either red every run or force the floors down to
// meaninglessness. They are evaluated exactly once, on the merged report, which
// is the only place the full world exists.
//
// The corollary is the failure mode this split introduces and #556 already
// taught this repo: a merged report assembled from FEWER blobs than were
// dispatched measures a smaller universe and passes. `scripts/ci/assert-shard-blobs.mjs`
// is the fail-closed guard for that, and the merge lane runs it before merging.
export default defineConfig({
  test: {
    projects: coverageProjects,
    coverage: {
      provider: "v8",
      // Blob-only on a shard: `json-summary`/`html` here would be a per-shard
      // artifact nobody reads, and writing them costs real time on 8 runners.
      reporter: [],
      reportsDirectory: "./coverage",
      include: coverageInclude,
      exclude: coverageExclude,
    },
  },
});
