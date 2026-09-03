import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  argvFor,
  nearestVitestProjectDir,
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

test("nearestVitestProjectDir walks up to the owning project, not the repo root", () => {
  const has = (candidate) =>
    [
      "packages/core/package.json",
      "packages/core/vitest.config.ts",
      "package.json",
      "vitest.config.ts",
    ].includes(candidate);
  assert.equal(
    nearestVitestProjectDir("packages/core/src/deep/a.test.ts", has),
    "packages/core"
  );
  assert.equal(nearestVitestProjectDir("scripts/ci/a.test.mjs", has), ".");
});

test("a package.json without a Vitest config is not a project", () => {
  const has = (candidate) =>
    [
      "packages/blueprints/apps/people/package.json",
      "packages/blueprints/package.json",
      "packages/blueprints/vitest.config.ts",
    ].includes(candidate);
  assert.equal(
    nearestVitestProjectDir(
      "packages/blueprints/apps/people/queries/share-links.test.ts",
      has
    ),
    "packages/blueprints"
  );
  assert.deepEqual(
    planRun("packages/blueprints/apps/people/queries/share-links.test.ts", has),
    {
      runner: "vitest",
      cwd: "packages/blueprints",
      filter: "apps/people/queries/share-links.test.ts",
    }
  );
});

test("every real test file plans onto a directory Vitest can collect from", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const has = (candidate) => existsSync(path.join(root, candidate));
  const CONFIGS = ["vitest.config.ts", "vitest.config.mts", "vite.config.ts"];
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(path.join(root, dir), {
      withFileTypes: true,
    })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith("."))
          continue;
        if (rel === "dist" || rel.endsWith("/dist")) continue;
        walk(rel);
      } else if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(entry.name)) {
        files.push(rel);
      }
    }
  };
  for (const top of ["packages", "apps", "scripts", "tests"]) {
    if (has(top)) walk(top);
  }
  assert.ok(
    files.length > 500,
    `expected the repo's suites, found ${files.length}`
  );
  const stranded = files
    .filter((file) => skipReason(file) === null)
    .map((file) => ({ file, plan: planRun(file, has) }))
    .filter(({ plan }) => plan.runner === "vitest" && !plan.config)
    .filter(
      ({ plan }) => !CONFIGS.some((name) => has(path.join(plan.cwd, name)))
    );
  assert.deepEqual(
    stranded.map(({ file, plan }) => `${file} -> ${plan.cwd}`),
    []
  );
});

test("each candidate is planned onto the runner that actually owns it", () => {
  const has = (candidate) =>
    [
      "packages/core/package.json",
      "packages/core/vitest.config.ts",
      "package.json",
    ].includes(candidate);
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
