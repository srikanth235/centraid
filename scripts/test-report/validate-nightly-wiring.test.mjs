import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { RESERVED_RIG_KEYS, rigPaths } from "./journey-rigs.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const e2ePath = path.join(root, ".github/workflows/e2e.yml");

/**
 * Structural unit tests for nightly wiring (#545 A9). Complements the
 * executable validate-nightly-wiring.mjs gate by asserting the #545 A1/A2
 * quality-outcome aggregator and mutation gating stay present.
 */
describe("validate-nightly-wiring structure (#545)", () => {
  const e2e = readFileSync(e2ePath, "utf8");

  test("mutation-testing job does not use continue-on-error on Stryker", () => {
    const mutationBlock = e2e.slice(
      e2e.indexOf("mutation-testing:"),
      e2e.indexOf("test-health-report:")
    );
    expect(mutationBlock).toMatch(/bun run test:mutation/u);
    expect(mutationBlock).not.toMatch(
      /continue-on-error:\s*true\s*\n\s*# Upload/u
    );
    // The Stryker step itself must not be continue-on-error.
    const strykerStep = mutationBlock.match(
      /name: Run Stryker[\s\S]*?(?=\n\s+- (?:name:|uses:)|$)/u
    );
    expect(strykerStep?.[0] ?? "").not.toMatch(/continue-on-error:\s*true/u);
  });

  test("test-health-report re-reads coverage/perf/scale outcomes into failure (A1)", () => {
    expect(e2e).toMatch(/Fail if quality lanes failed/u);
    expect(e2e).toMatch(/steps\.coverage\.outcome/u);
    expect(e2e).toMatch(/steps\.perf\.outcome/u);
    expect(e2e).toMatch(/steps\.scale\.outcome/u);
  });

  test("the rolling-issue job sees every lane, mutation-testing included (A2)", () => {
    // #915 Wave 0 replaced the single `nightly-failure-issue` with one rolling
    // issue per lane, and its body iterates `toJSON(needs)` instead of a
    // hand-maintained list of `needs.<job>.result` lines — which is what let
    // fuzz-parsers and dast-scan go uncovered. So the invariant moved: the job
    // must NEED the lane, not name it in a body.
    const failBlock = e2e.slice(e2e.indexOf("nightly-lane-issues:"));
    expect(failBlock).toMatch(/mutation-testing/u);
    expect(failBlock).toMatch(/toJSON\(needs\)/u);
  });

  test("a failed issue create is loud, never swallowed (A11)", () => {
    // #557 moved the open-or-update logic out of four near-identical inline
    // shell blocks into scripts/ci/file-tracking-issue.mjs. The A11 invariant
    // is unchanged — a failed create must not be swallowed — so this asserts it
    // in both halves: the workflow delegates rather than hand-rolling `gh`, and
    // the script it delegates to exits non-zero. (The decision tree itself is
    // covered by scripts/ci/file-tracking-issue.test.mjs.)
    const failBlock = e2e.slice(e2e.indexOf("nightly-lane-issues:"));
    expect(failBlock).toMatch(/scripts\/ci\/file-tracking-issue\.mjs/u);
    expect(failBlock).not.toMatch(/gh issue create/u);
    expect(failBlock).not.toMatch(/gh issue create[^\n]*\|\|\s*true/u);

    const filer = readFileSync(
      path.join(root, "scripts/ci/file-tracking-issue.mjs"),
      "utf8"
    );
    expect(filer).toMatch(
      /::error::Failed to \$\{result\.action\} tracking issue/u
    );
    expect(filer).toMatch(/process\.exitCode = 1/u);
  });

  test("every workflow that files a tracking issue uses the shared filer", () => {
    // The four copies had already drifted before they were merged — one lost
    // its `--label` fallback, another swallowed every failure with
    // `|| echo "::warning::"`. Nothing is left to drift back apart.
    for (const workflow of [
      "e2e.yml",
      "extension-e2e.yml",
      "interop-weekly.yml",
    ]) {
      const source = readFileSync(
        path.join(root, ".github/workflows", workflow),
        "utf8"
      );
      expect(
        source,
        `${workflow} must not hand-roll gh issue create`
      ).not.toMatch(/gh issue create/u);
      expect(
        source,
        `${workflow} must not hand-roll gh issue comment`
      ).not.toMatch(/gh issue comment/u);
    }
  });
});

describe("tests/journeys.json#rigs reserved keys (#927)", () => {
  test("a waiver is not a rig, so nothing tries to stat it", () => {
    const rigs = {
      approvedDeviation: "#927 removed the rigs that cited no entry",
      _comment: "why this section exists",
      "tests/perf/gateway-request.perf.test.ts": { lane: "perf" },
    };
    expect(rigPaths(rigs)).toEqual(["tests/perf/gateway-request.perf.test.ts"]);
  });

  test("real rig paths are still returned, in declaration order", () => {
    const rigs = {
      "tests/scale/large-vault.scale.test.ts": {},
      approvedDeviation: "x",
      "tests/perf/work-counters.perf.test.ts": {},
    };
    expect(rigPaths(rigs)).toEqual([
      "tests/scale/large-vault.scale.test.ts",
      "tests/perf/work-counters.perf.test.ts",
    ]);
  });

  test("an absent or empty map yields no rigs", () => {
    expect(rigPaths(undefined)).toEqual([]);
    expect(rigPaths({})).toEqual([]);
  });

  test("the reserved set is exactly the two metadata keys", () => {
    expect([...RESERVED_RIG_KEYS].sort()).toEqual([
      "_comment",
      "approvedDeviation",
    ]);
  });
});
