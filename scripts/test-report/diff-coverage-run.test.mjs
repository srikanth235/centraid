import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, test } from "vitest";

import {
  changedFiles,
  parseArgs,
  projectNameOf,
  resolveBase,
  run,
  workspaceDirOf,
} from "./diff-coverage-run.mjs";

describe("parseArgs", () => {
  test("defaults: no base, no dependents", () => {
    expect(parseArgs([])).toStrictEqual({ base: null, dependents: false });
  });

  test("--base consumes its value and --dependents is a flag", () => {
    expect(parseArgs(["--base", "origin/main", "--dependents"])).toStrictEqual({
      base: "origin/main",
      dependents: true,
    });
  });

  test("a trailing --base with no value stays null rather than eating undefined", () => {
    expect(parseArgs(["--base"])).toStrictEqual({
      base: null,
      dependents: false,
    });
  });
});

describe("resolveBase", () => {
  test("an explicit base short-circuits ref probing entirely", () => {
    // 'definitely-not-a-ref' would fail rev-parse; returning it proves the
    // explicit path never consults git.
    expect(resolveBase("definitely-not-a-ref")).toBe("definitely-not-a-ref");
  });
});

describe("changedFiles", () => {
  test("HEAD-vs-HEAD plus the working tree is deduped, trimmed, and never throws", () => {
    // Committed range is empty by construction; anything present comes from the
    // working tree unions. The contract under test is shape, not content.
    const files = changedFiles("HEAD");
    expect(Array.isArray(files)).toBe(true);
    expect(files).toStrictEqual([...new Set(files)]);
    for (const f of files) expect(f).toBe(f.trim());
  });

  test("an unresolvable base degrades to the working-tree union, not a throw", () => {
    expect(() => changedFiles("definitely-not-a-ref")).not.toThrow();
  });
});

describe("run", () => {
  test("propagates the child exit status in both directions", () => {
    expect(run("node", ["-e", ""])).toBe(0);
    expect(run("node", ["-e", "process.exit(3)"])).toBe(3);
  });
});

describe("workspaceDirOf", () => {
  test("maps packages/ and apps/ sources to their workspace dir", () => {
    expect(workspaceDirOf("packages/gateway/src/serve/build-gateway.ts")).toBe(
      "packages/gateway"
    );
    expect(workspaceDirOf("apps/mobile/src/lib/upload/enqueue.ts")).toBe(
      "apps/mobile"
    );
    expect(
      workspaceDirOf("packages/blueprints/apps/tasks/handlers/create.ts")
    ).toBe("packages/blueprints");
  });

  test("root-level and non-workspace paths own no project", () => {
    expect(workspaceDirOf("scripts/test-report/diff-coverage.mjs")).toBeNull();
    expect(workspaceDirOf("package.json")).toBeNull();
    expect(workspaceDirOf("packages")).toBeNull();
  });
});

describe("projectNameOf", () => {
  // Fixture workspaces under a temp root, addressed via a path RELATIVE to the
  // repo root (the function resolves against the repo), so the test controls
  // exactly which files exist.
  const repoRoot = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../.."
  );
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "diff-coverage-run-"));
  const relFixture = path.relative(repoRoot, fixtureRoot);
  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  test("a workspace with a vitest config reports its package name", () => {
    const dir = path.join(fixtureRoot, "with-vitest");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "@x/with-vitest" })
    );
    writeFileSync(path.join(dir, "vitest.config.ts"), "export default {}");
    expect(projectNameOf(path.join(relFixture, "with-vitest"))).toBe(
      "@x/with-vitest"
    );
  });

  test("a workspace without a vitest config contributes no project — naming it would make --project fail", () => {
    const dir = path.join(fixtureRoot, "no-vitest");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "@x/no-vitest" })
    );
    expect(projectNameOf(path.join(relFixture, "no-vitest"))).toBeNull();
  });

  test("a missing or unparseable manifest is null, never a throw", () => {
    expect(projectNameOf(path.join(relFixture, "does-not-exist"))).toBeNull();
    const dir = path.join(fixtureRoot, "bad-json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), "{not json");
    writeFileSync(path.join(dir, "vitest.config.ts"), "export default {}");
    expect(projectNameOf(path.join(relFixture, "bad-json"))).toBeNull();
  });

  test("a manifest with no usable name is null", () => {
    const dir = path.join(fixtureRoot, "unnamed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ private: true })
    );
    writeFileSync(path.join(dir, "vitest.config.ts"), "export default {}");
    expect(projectNameOf(path.join(relFixture, "unnamed"))).toBeNull();
  });
});
