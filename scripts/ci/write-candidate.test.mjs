import assert from "node:assert/strict";
import test from "node:test";

import {
  HISTORY_LIMIT,
  appendHistory,
  buildCandidate,
  laneVerdicts,
} from "./write-candidate.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

test("a skipped lane is recorded as skipped, never as a pass", () => {
  assert.deepEqual(
    laneVerdicts({
      "mobile-canary-android": { result: "success" },
      "desktop-e2e-macos": { result: "skipped" },
      codeql: { result: "failure" },
      promote: { result: "success" },
    }),
    {
      "mobile-canary-android": { verdict: "passed", durationMs: 0 },
      "desktop-e2e-macos": { verdict: "skipped", durationMs: 0 },
      codeql: { verdict: "failed", durationMs: 0 },
    }
  );
  assert.deepEqual(laneVerdicts(null), {});
});

test("the candidate record carries the C1 shape", () => {
  const candidate = buildCandidate({
    sha: SHA,
    previousSha: OTHER,
    runId: "7",
    runUrl: "https://example.test/7",
    promotedAt: "2026-09-02T12:00:00.000Z",
    lanes: {},
  });
  assert.deepEqual(candidate, {
    schema: 1,
    sha: SHA,
    promotedAt: "2026-09-02T12:00:00.000Z",
    previousSha: OTHER,
    runId: "7",
    runUrl: "https://example.test/7",
    lanes: {},
  });
});

test("the first promotion has a null previousSha, and a bad SHA throws", () => {
  assert.equal(
    buildCandidate({
      sha: SHA,
      previousSha: "",
      runId: "1",
      runUrl: "u",
      promotedAt: "t",
      lanes: {},
    }).previousSha,
    null
  );
  assert.throws(
    () =>
      buildCandidate({
        sha: "nope",
        previousSha: null,
        runId: "1",
        runUrl: "u",
        promotedAt: "t",
        lanes: {},
      }),
    /40-hex/u
  );
  assert.throws(
    () =>
      buildCandidate({
        sha: SHA,
        previousSha: "short",
        runId: "1",
        runUrl: "u",
        promotedAt: "t",
        lanes: {},
      }),
    /--previous/u
  );
});

test("history is newest first, deduped by sha, and bounded", () => {
  const first = appendHistory(null, { sha: SHA, promotedAt: "1" });
  assert.deepEqual(first.candidates, [{ sha: SHA, promotedAt: "1" }]);
  const second = appendHistory(first, { sha: OTHER, promotedAt: "2" });
  assert.deepEqual(
    second.candidates.map((c) => c.sha),
    [OTHER, SHA]
  );
  const requeued = appendHistory(second, { sha: SHA, promotedAt: "3" });
  assert.deepEqual(
    requeued.candidates.map((c) => c.sha),
    [SHA, OTHER]
  );

  const long = {
    candidates: Array.from({ length: HISTORY_LIMIT + 10 }, (_, index) => ({
      sha: String(index).padStart(40, "0"),
      promotedAt: "x",
    })),
  };
  assert.equal(
    appendHistory(long, { sha: SHA, promotedAt: "y" }).candidates.length,
    HISTORY_LIMIT
  );
});

test("an unreadable history file is replaced rather than propagated", () => {
  assert.deepEqual(
    appendHistory({ candidates: "nonsense" }, { sha: SHA, promotedAt: "1" })
      .candidates,
    [{ sha: SHA, promotedAt: "1" }]
  );
});
