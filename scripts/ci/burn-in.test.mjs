import assert from "node:assert/strict";
import test from "node:test";

import {
  argvFor,
  nearestPackageDir,
  parseShard,
  partitionChangedFiles,
  planRun,
  selectShard,
  skipReason,
  verdictForRuns,
} from "./burn-in.mjs";

test("only *.test.* / *.spec.* modules Vitest can load are candidates", () => {
  assert.equal(skipReason("packages/core/src/a.test.ts"), null);
  assert.equal(skipReason("packages/core/src/a.spec.tsx"), null);
  assert.equal(skipReason("scripts/ci/burn-in.test.mjs"), null);
  assert.match(skipReason("packages/core/src/a.ts"), /not a test file/u);
  assert.match(
    skipReason("apps/mobile/flows/pairing.test.yaml"),
    /not a Vitest module/u
  );
});

test("Playwright and Maestro specs are skipped with a reason, not silently", () => {
  assert.match(
    skipReason("tests/e2e/vault.spec.ts"),
    /Playwright\/Maestro \(tests\/e2e\/\)/u
  );
  assert.match(
    skipReason("apps/web/tests/e2e/pwa.spec.ts"),
    /Playwright\/Maestro/u
  );
  assert.match(skipReason("packages/server/e2e/boot.test.ts"), /\/e2e\/ path/u);
});

test("nightly rigs are skipped: their input is another job's artifact", () => {
  // Regression (#915): desktop-launch.perf.test.ts throws under CI when the
  // nightly desktop-e2e report is absent — correct at rung 4, and a guaranteed
  // "broken test" verdict at rung 2, where the artifact cannot exist.
  assert.match(
    skipReason("tests/perf/desktop-launch.perf.test.ts"),
    /nightly rig fed by another job's artifact/u
  );
  assert.match(skipReason("tests/scale/backup.scale.test.ts"), /nightly rig/u);
  assert.equal(skipReason("tests/quality/user-facing-qualities.test.ts"), null);
});

test("partitionChangedFiles reports skips and ignores non-test files entirely", () => {
  const { files, skipped } = partitionChangedFiles(
    [
      "packages/core/src/a.test.ts",
      "packages/core/src/a.ts",
      "tests/e2e/b.spec.ts",
      "",
      "  apps/web/src/c.spec.tsx  ",
    ].join("\n")
  );
  assert.deepEqual(files, [
    "packages/core/src/a.test.ts",
    "apps/web/src/c.spec.tsx",
  ]);
  assert.deepEqual(
    skipped.map((s) => s.file),
    ["tests/e2e/b.spec.ts"]
  );
});

test("nearestPackageDir walks up to the owning package, not the repo root", () => {
  const has = (candidate) =>
    candidate === "packages/core/package.json" || candidate === "package.json";
  assert.equal(
    nearestPackageDir("packages/core/src/deep/a.test.ts", has),
    "packages/core"
  );
  assert.equal(nearestPackageDir("scripts/ci/a.test.mjs", has), ".");
});

test("each candidate is planned onto the runner that actually owns it", () => {
  const has = (candidate) =>
    ["packages/core/package.json", "package.json"].includes(candidate);
  // Regression (#915): `scripts/**` unit tests are node:test modules. Planning
  // them onto a root Vitest run collected zero files and reported every one of
  // them as a broken test.
  assert.deepEqual(planRun("scripts/ci/lane-health.test.mjs", has), {
    runner: "node",
    cwd: ".",
    filter: "scripts/ci/lane-health.test.mjs",
  });
  assert.deepEqual(planRun("scripts/test-report/derive.test.mjs", has), {
    runner: "vitest",
    cwd: ".",
    filter: "scripts/test-report/derive.test.mjs",
    config: "scripts/test-report/vitest.config.ts",
  });
  assert.equal(
    planRun("scripts/release/candidate-guard.test.mjs", has).config,
    "scripts/release/vitest.config.ts"
  );
  assert.equal(
    planRun("tests/quality/user-facing-qualities.test.ts", has).config,
    "vitest.quality.config.ts"
  );
  assert.equal(
    planRun("tests/integration-mobile/parked.integration.test.ts", has).config,
    "tests/integration-mobile/vitest.config.ts"
  );
  // Everything the table does not claim runs from its owning package.
  assert.deepEqual(planRun("packages/core/src/a.test.ts", has), {
    runner: "vitest",
    cwd: "packages/core",
    filter: "src/a.test.ts",
  });
});

test("argvFor names the runner's own invocation, not a generic one", () => {
  assert.deepEqual(argvFor({ runner: "node", filter: "scripts/a.test.mjs" }), [
    "--test",
    "scripts/a.test.mjs",
  ]);
  const vitest = argvFor({
    runner: "vitest",
    filter: "tests/perf/a.perf.test.ts",
    config: "vitest.perf.config.ts",
  });
  assert.deepEqual(vitest.slice(1), [
    "run",
    "--config",
    "vitest.perf.config.ts",
    "tests/perf/a.perf.test.ts",
    "--no-coverage",
  ]);
  assert.match(vitest[0], /vitest\.mjs$/u);
  assert.deepEqual(argvFor({ runner: "vitest", filter: "src/a.test.ts" }), [
    vitest[0],
    "run",
    "src/a.test.ts",
    "--no-coverage",
  ]);
});

test("the shards partition the list: every file once, none twice, none lost", () => {
  // The property, not an example: a sharded gate's failure mode is a file in no
  // shard, which never runs and reports green by absence (#916).
  const files = Array.from(
    { length: 237 },
    (_, index) => `packages/p${index % 7}/src/a${index}.test.ts`
  );
  for (const total of [1, 2, 3, 8, 237, 400]) {
    const legs = Array.from({ length: total }, (_, index) =>
      selectShard(files, index + 1, total)
    );
    const seen = legs.flat();
    assert.deepEqual(
      [...seen].sort(),
      [...files].sort(),
      `N=${total} must cover every file exactly once`
    );
    assert.equal(
      new Set(seen).size,
      seen.length,
      `N=${total} must not overlap`
    );
    // Round-robin, so no leg can be handed a run's worth more than another.
    const sizes = legs.map((leg) => leg.length);
    assert.ok(
      Math.max(...sizes) - Math.min(...sizes) <= 1,
      `N=${total} balance`
    );
  }
});

test("the deal does not depend on the order the caller handed in", () => {
  const files = ["c.test.ts", "a.test.ts", "b.test.ts", "d.test.ts"];
  const reversed = files.toReversed();
  for (let shard = 1; shard <= 3; shard += 1) {
    assert.deepEqual(
      selectShard(files, shard, 3),
      selectShard(reversed, shard, 3)
    );
  }
});

test("a malformed or out-of-range shard is an error, never an empty slice", () => {
  assert.deepEqual(parseShard("3/8"), { shard: 3, total: 8 });
  assert.deepEqual(parseShard(" 1/1 "), { shard: 1, total: 1 });
  // Each of these selects nothing, and "nothing" exits 0 — the silent green a
  // burn-in cannot survive.
  assert.throws(() => parseShard("0/8"), /out of range/u);
  assert.throws(() => parseShard("9/8"), /out of range/u);
  assert.throws(() => parseShard("3/0"), /must be >= 1/u);
  assert.throws(() => parseShard("3"), /wants "i\/N"/u);
  assert.throws(() => parseShard("a/b"), /wants "i\/N"/u);
  assert.throws(() => parseShard(""), /wants "i\/N"/u);
});

test("three green runs pass; any disagreement is red", () => {
  assert.equal(verdictForRuns([true, true, true]).ok, true);
  const flaky = verdictForRuns([true, false, true]);
  assert.equal(flaky.ok, false);
  assert.match(flaky.why, /DISAGREED/u);
  const broken = verdictForRuns([false, false, false]);
  assert.equal(broken.ok, false);
  assert.match(broken.why, /broken, not flaky/u);
});
