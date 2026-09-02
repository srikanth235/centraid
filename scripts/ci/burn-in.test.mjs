import assert from "node:assert/strict";
import test from "node:test";

import {
  groupByPackage,
  nearestPackageDir,
  partitionChangedFiles,
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

test("groupByPackage collects every file under its own project", () => {
  const has = (candidate) =>
    ["packages/core/package.json", "apps/web/package.json"].includes(candidate);
  const groups = groupByPackage(
    [
      "packages/core/src/a.test.ts",
      "packages/core/src/b.test.ts",
      "apps/web/src/c.test.ts",
      "scripts/ci/d.test.mjs",
    ],
    has
  );
  assert.deepEqual(groups.get("packages/core"), [
    "packages/core/src/a.test.ts",
    "packages/core/src/b.test.ts",
  ]);
  assert.deepEqual(groups.get("apps/web"), ["apps/web/src/c.test.ts"]);
  assert.deepEqual(groups.get("."), ["scripts/ci/d.test.mjs"]);
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
