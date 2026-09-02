import assert from "node:assert/strict";
import test from "node:test";

import {
  argvFor,
  nearestPackageDir,
  partitionChangedFiles,
  planRun,
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
    planRun("tests/perf/desktop-launch.perf.test.ts", has).config,
    "vitest.perf.config.ts"
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

test("three green runs pass; any disagreement is red", () => {
  assert.equal(verdictForRuns([true, true, true]).ok, true);
  const flaky = verdictForRuns([true, false, true]);
  assert.equal(flaky.ok, false);
  assert.match(flaky.why, /DISAGREED/u);
  const broken = verdictForRuns([false, false, false]);
  assert.equal(broken.ok, false);
  assert.match(broken.why, /broken, not flaky/u);
});
