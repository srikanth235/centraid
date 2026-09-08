import assert from "node:assert/strict";
import test from "node:test";

import {
  claimedPath,
  claimedPaths,
  duplicateGlobs,
  escapeHatchProblems,
  lintPathFilters,
  parseFilters,
  pathsRequiringClaim,
} from "./lint-path-filters.mjs";

const CI_FRAGMENT = `
jobs:
  changes:
    steps:
      - uses: dorny/paths-filter@abc
        id: filter
        with:
          filters: |
            web:
              - 'apps/web/**'
              - 'packages/design/**'
            gateway:
              - 'packages/server/**'
              - 'packages/server/**'
  static:
    runs-on: ubuntu-latest
`;

test("parseFilters reads the literal block by indentation", () => {
  const filters = parseFilters(CI_FRAGMENT);
  assert.deepEqual(Object.keys(filters), ["web", "gateway"]);
  assert.deepEqual(filters.web, ["apps/web/**", "packages/design/**"]);
});

test("parseFilters stops at the end of the block rather than eating the next job", () => {
  const filters = parseFilters(CI_FRAGMENT);
  assert.equal(Object.keys(filters).includes("static"), false);
});

test("parseFilters returns null when the table is not where it is expected", () => {
  assert.equal(parseFilters("jobs:\n  static:\n    runs-on: x\n"), null);
});

test("duplicateGlobs finds the hand-kept-table wear", () => {
  const problems = duplicateGlobs(parseFilters(CI_FRAGMENT));
  assert.equal(problems.length, 1);
  assert.match(
    problems[0],
    /`gateway` lists `packages\/server\/\*\*` 2 times/u
  );
});

test("claimedPath strips the glob tail", () => {
  assert.equal(claimedPath("packages/server/**"), "packages/server");
  assert.equal(claimedPath("apps/mobile/*"), "apps/mobile");
  assert.equal(claimedPath("Dockerfile"), "Dockerfile");
});

test("claimedPaths claims every ancestor, because a deep glob does wake a lane", () => {
  const claimed = claimedPaths({ x: ["packages/blueprints/apps/locker/**"] });
  assert.equal(claimed.has("packages/blueprints"), true);
  assert.equal(claimed.has("packages/blueprints/apps/locker"), true);
});

test("pathsRequiringClaim names workspaces and top-level dirs, not root files", () => {
  const required = pathsRequiringClaim([
    "packages/vault/src/a.ts",
    "apps/web/src/b.ts",
    "docs/x.md",
    "README.md",
    ".github/workflows/ci.yml",
  ]);
  assert.deepEqual([...required].sort(), [
    "apps/web",
    "docs",
    "packages/vault",
  ]);
});

test("an unclaimed path fails and the message names the consequence", () => {
  const errors = lintPathFilters(
    { web: ["apps/web/**"] },
    ["apps/web/src/a.ts", "packages/orphan/src/b.ts"],
    { alwaysOn: {} }
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /packages\/orphan/u);
  assert.match(errors[0], /`skipped` counts as a PASS/u);
});

test("a ledger entry claims a path — but only with a real reason", () => {
  const tracked = ["apps/web/src/a.ts", "packages/orphan/src/b.ts"];
  assert.deepEqual(
    lintPathFilters({ web: ["apps/web/**"] }, tracked, {
      alwaysOn: {
        "packages/orphan":
          "covered by `verify`, which is unfiltered and runs the whole suite",
      },
    }),
    []
  );
  assert.match(
    lintPathFilters({ web: ["apps/web/**"] }, tracked, {
      alwaysOn: { "packages/orphan": "covered" },
    })[0],
    /must name the always-on job/u
  );
});

test("escapeHatchProblems accepts a read that carries the `all` fallback", () => {
  assert.deepEqual(
    escapeHatchProblems(
      "    if: needs.changes.outputs.docs == 'true' || needs.changes.outputs.all == 'true'\n"
    ),
    []
  );
});

test("escapeHatchProblems catches the `with:` read the `if:`-only reasoning missed", () => {
  const problems = escapeHatchProblems(
    `    if: needs.changes.outputs.client == 'true' || needs.changes.outputs.all == 'true'
    with:
      web: \${{ needs.changes.outputs.web == 'true' }}
`
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /ci\.yml:3 reads `web`/u);
  assert.match(problems[0], /counts as a PASS/u);
});

test("escapeHatchProblems ignores a line that only reads `all`", () => {
  assert.deepEqual(
    escapeHatchProblems("    if: needs.changes.outputs.all == 'true'\n"),
    []
  );
});

test("escapeHatchProblems reads a folded `if:` as one condition, not two lines", () => {
  const folded =
    "    if: >\n      needs.changes.outputs.docs == 'true' ||\n      needs.changes.outputs.all == 'true'\n    runs-on: ubuntu-latest\n";
  assert.deepEqual(escapeHatchProblems(folded), []);

  const missing =
    "    if: >\n      needs.changes.outputs.docs == 'true'\n    runs-on: ubuntu-latest\n";
  const problems = escapeHatchProblems(missing);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /ci\.yml:1 reads `docs`/u);
});

test("escapeHatchProblems does not swallow the line after a folded block", () => {
  const problems = escapeHatchProblems(
    `    if: >
      always()
    web: \${{ needs.changes.outputs.web == 'true' }}
`
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /ci\.yml:3 reads `web`/u);
});

test("a ledger entry for a path that no longer exists fails as stale", () => {
  const errors = lintPathFilters(
    { web: ["apps/web/**"] },
    ["apps/web/src/a.ts"],
    {
      alwaysOn: {
        "packages/deleted":
          "covered by `verify`, which is unfiltered and runs the whole suite",
      },
    }
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no longer in the tree/u);
});
