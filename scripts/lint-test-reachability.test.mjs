#!/usr/bin/env node
// The reachability gate's own seeded-red case (#931 item 1).
//
// The gate exists because an unreachable test file is invisible: it fails
// nothing, it reports nothing, and the suite around it is green. So the test
// that matters is the SEEDED one — an unlisted `scripts/foo.test.mjs` must be
// reported, and the same file must stop being reported the moment a runner
// names it. Everything else here defends the matcher those two cases rest on.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import {
  RUNNERS,
  assertEveryConfigModelled,
  filesNamedByScripts,
  findOrphans,
  flattenProjects,
  globToRegExp,
  matchesAny,
  playwrightDirs,
} from "./lint-test-reachability.mjs";

const root = path.resolve(import.meta.dirname, "..");
const project = (include, exclude = []) => ({
  root: path.join(root, "packages/core"),
  include,
  exclude,
});

test("an unlisted scripts/foo.test.mjs is an orphan; a listed one is not", () => {
  const files = ["scripts/foo.test.mjs", "packages/core/src/a.test.ts"];
  const projects = [project(["src/**/*.test.ts"])];
  // SEEDED RED: nothing names it.
  assert.deepEqual(
    findOrphans({
      files,
      projects,
      named: new Set(),
      playwright: [],
    }),
    ["scripts/foo.test.mjs"]
  );
  // GREEN: `scripts:test` hands it to `node --test`.
  assert.deepEqual(
    findOrphans({
      files,
      projects,
      named: filesNamedByScripts({
        "scripts:test": "node --test scripts/foo.test.mjs",
      }),
      playwright: [],
    }),
    []
  );
});

test("a file a project's include misses, or its exclude removes, is an orphan", () => {
  const files = ["packages/core/src/a.test.ts"];
  assert.deepEqual(
    findOrphans({
      files,
      projects: [project(["src/**/*.test.tsx"])],
      named: new Set(),
      playwright: [],
    }),
    ["packages/core/src/a.test.ts"]
  );
  assert.deepEqual(
    findOrphans({
      files,
      projects: [project(["src/**/*.test.ts"], ["src/a.test.ts"])],
      named: new Set(),
      playwright: [],
    }),
    ["packages/core/src/a.test.ts"]
  );
  // Excluded by one project, included by another — the mobile stub/RNTL split.
  assert.deepEqual(
    findOrphans({
      files,
      projects: [
        project(["src/**/*.test.ts"], ["src/a.test.ts"]),
        project(["src/a.test.ts"]),
      ],
      named: new Set(),
      playwright: [],
    }),
    []
  );
});

test("a Playwright spec is reached by the config that owns its directory", () => {
  const files = [
    "apps/web/tests/e2e/notes.spec.ts",
    "apps/web/tests/e2e/helpers.ts",
  ];
  assert.deepEqual(
    findOrphans({
      files,
      projects: [],
      named: new Set(),
      playwright: [{ dir: "apps/web/tests/e2e" }],
    }),
    []
  );
  // A different folder is not covered by that config.
  assert.deepEqual(
    findOrphans({
      files: ["apps/desktop/tests/e2e/notes.spec.ts"],
      projects: [],
      named: new Set(),
      playwright: [{ dir: "apps/web/tests/e2e" }],
    }),
    ["apps/desktop/tests/e2e/notes.spec.ts"]
  );
});

test("the glob compiler handles the forms the repo's configs use", () => {
  assert.ok(globToRegExp("src/**/*.test.ts").test("src/a/b/c.test.ts"));
  assert.ok(globToRegExp("src/**/*.test.ts").test("src/c.test.ts"));
  assert.ok(!globToRegExp("src/**/*.test.ts").test("other/c.test.ts"));
  assert.ok(!globToRegExp("src/*.test.ts").test("src/a/c.test.ts"));
  assert.ok(
    globToRegExp("**/*.{test,spec}.?(c|m)[jt]s?(x)").test("a/b.spec.mtsx")
  );
  assert.ok(
    globToRegExp("**/*.@(spec|test).?(c|m)[jt]s?(x)").test("a/b.spec.ts")
  );
  assert.ok(!globToRegExp("**/*.@(spec|test).?(c|m)[jt]s?(x)").test("a/b.ts"));
  // A literal dot must not become "any character": `a-test-ts` is not a test.
  assert.ok(!globToRegExp("*.test.ts").test("axtestxts"));
  assert.throws(() => globToRegExp("!(a).ts"), /unsupported extglob/u);
});

test("matchesAny is a disjunction over the include list", () => {
  assert.ok(
    matchesAny("src/a.test.tsx", ["src/**/*.test.ts", "src/**/*.test.tsx"])
  );
  assert.ok(!matchesAny("src/a.ts", ["src/**/*.test.ts"]));
});

test("flattenProjects resolves package entries against their own directory", async () => {
  const configs = {
    "packages/core/vitest.config.ts": {
      test: { include: ["src/**/*.test.ts"] },
    },
  };
  const projects = await flattenProjects(
    { test: { projects: ["packages/core"] } },
    root,
    async (rel) => configs[rel]
  );
  assert.deepEqual(projects, [
    {
      root: path.join(root, "packages/core"),
      include: ["src/**/*.test.ts"],
      exclude: [],
    },
  ]);
});

test("flattenProjects gives an includeless project vitest's default", async () => {
  const projects = await flattenProjects({ test: {} }, root, async () => ({}));
  assert.deepEqual(projects[0].include, ["**/*.{test,spec}.?(c|m)[jt]s?(x)"]);
});

test("a vitest config no runner models is a failure, not a silent gap", () => {
  const projects = [{ root: path.join(root, "packages/core") }];
  assert.deepEqual(
    assertEveryConfigModelled(
      [
        "vitest.config.ts",
        "packages/core/vitest.config.ts",
        "packages/core/vitest.mutation.config.ts",
      ],
      projects
    ),
    []
  );
  const failures = assertEveryConfigModelled(
    ["apps/newthing/vitest.config.ts"],
    projects
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /apps\/newthing\/vitest\.config\.ts/u);
});

test("every runner in the table names a config that exists", () => {
  for (const runner of RUNNERS) {
    assert.ok(
      globToRegExp("**/vitest*.config.ts").test(runner.config) ||
        runner.config.startsWith("vitest"),
      `${runner.config} does not look like a vitest config`
    );
  }
});

test("playwrightDirs resolves the dirname forms the configs use", () => {
  assert.deepEqual(
    playwrightDirs(
      ["apps/web/tests/e2e/playwright.config.ts"],
      () => "testDir: here,"
    ),
    [
      {
        dir: "apps/web/tests/e2e",
        config: "apps/web/tests/e2e/playwright.config.ts",
      },
    ]
  );
  assert.deepEqual(
    playwrightDirs(["a/playwright.config.ts"], () => 'testDir: "./specs",'),
    [{ dir: "a/specs", config: "a/playwright.config.ts" }]
  );
  assert.throws(
    () =>
      playwrightDirs(["a/playwright.config.ts"], () => "testDir: resolveIt(),"),
    /is not a folder this gate can resolve/u
  );
});

test("the gate is green on this tree", () => {
  const run = spawnSync(
    "bun",
    [path.join(root, "scripts/lint-test-reachability.mjs")],
    {
      cwd: root,
      encoding: "utf8",
    }
  );
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /every one reached by a runner/u);
});
