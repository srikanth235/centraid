import assert from "node:assert/strict";
// Unit tests for the ledger validator (#915 Wave 4).
//
// The interesting cases are the ones that only exist BECAUSE of the merge: the
// base-side fallback to the pre-merge file paths (without it every ratchet in
// the repo goes silent for exactly one commit), the per-section waiver scope
// (merging seven files must not merge seven waivers), and the serializer that
// keeps a scanner's `--write` output byte-identical to what oxfmt would print.
//
// Each case builds a throwaway git repository, commits the PRE-MERGE tree, and
// then runs the validator over a POST-MERGE working tree against that commit —
// which is the exact situation the merge commit itself is in.
import { execFileSync } from "node:child_process";
// oxlint-disable-next-line no-restricted-imports -- (#915) node --test lane: the kit's tempDir() registers a vitest afterAll at import time and throws here; removal is registered in the `after` hook below. Same pattern as scripts/check-comment-density-ratchet.test.mjs.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, describe } from "node:test";

import {
  budgetNumbers,
  checkLedgers,
  minimumTestsMirror,
  mobileSuitesMirror,
  serializeLedger,
  shapeLegacy,
} from "./check-ledgers.mjs";

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const COVERAGE = { approvedDeviation: "seed", "packages/a/**": { lines: 90 } };
const MUTATION = { "packages/a": 80 };
const CLAIMS = { flows: [{ id: "f1", owner: "a.ts", minimumTests: 4 }] };
const ROSTER = { suites: { "pr-gate": { budgetMs: 480_000 } } };

/** A repo whose HEAD holds the PRE-MERGE ledgers, ready for a merged head. */
function preMergeRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "ledgers-"));
  roots.push(root);
  mkdirSync(path.join(root, "tests/agent-e2e-mobile"), { recursive: true });
  const write = (rel, value) =>
    writeFileSync(path.join(root, rel), `${JSON.stringify(value, null, 2)}\n`);
  write("tests/coverage-floors.json", COVERAGE);
  write("tests/mutation-floors.json", MUTATION);
  write("tests/suite-wall-clock.json", {
    approvedDeviation: "seed",
    lanes: { "pr-vitest": { budgetMs: 1000 } },
  });
  write("tests/claims.json", CLAIMS);
  write("tests/agent-e2e-mobile/roster.json", ROSTER);
  for (const cmd of [
    ["init", "-q"],
    ["config", "user.email", "t@example.com"],
    ["config", "user.name", "t"],
    ["add", "-A"],
    ["commit", "-qm", "pre-merge"],
  ]) {
    execFileSync("git", ["-C", root, ...cmd], { stdio: "ignore" });
  }
  return { root, write };
}

/** The merged four-file tree, with `overrides` folded into the sections. */
function writeMerged(write, overrides = {}) {
  write("tests/floors.json", {
    coverage: overrides.coverage ?? COVERAGE,
    mutation: overrides.mutation ?? MUTATION,
    minimumTests: { flows: overrides.minimumTests ?? { f1: 4 } },
  });
  write("tests/budgets.json", {
    suiteWallClock: overrides.suiteWallClock ?? {
      approvedDeviation: "seed",
      lanes: { "pr-vitest": { budgetMs: 1000 } },
    },
    rungs: { 2: 900_000 },
    qualityRigs: { rigs: {} },
    experience: { files: ["tests/claims.json"] },
    designTokenCss: { budgets: {} },
    mobileSuites: { suites: overrides.mobileSuites ?? { "pr-gate": 480_000 } },
  });
  write("tests/inventory.json", {
    skips: {
      _entries: "exceptions",
      _budget: 1,
      sites: overrides.skip ?? {
        "a.ts#1": { issue: 1, expires: "2099-01-01" },
      },
    },
    envRed: { _entries: "exceptions", _budget: 0, sites: {} },
    sleeps: {
      _entries: "population",
      issue: 915,
      expires: "2099-01-01",
      _budget: 0,
      sites: {},
    },
    hygiene: {
      _entries: "population",
      issue: 915,
      expires: "2099-01-01",
      budgets: {},
    },
    commentDensity: {
      _entries: "population",
      issue: 915,
      expires: "2099-01-01",
      files: {},
    },
    naCells: { source: "tests/claims.json#naCells" },
    advisory: { _entries: "exceptions", steps: {} },
  });
  write("tests/quarantine.json", {
    _policy: { maxDays: 30, budget: 0 },
    entries: [],
    lanes: overrides.lanes ?? {},
  });
}

const run = (root) => {
  const { errors } = checkLedgers({
    baseRef: "HEAD",
    root,
    today: "2026-09-02",
  });
  return errors;
};

describe("the base-side fallback across the merge", () => {
  test("a clean rename of every ledger passes", () => {
    const { root, write } = preMergeRepo();
    writeMerged(write);
    assert.deepEqual(run(root), []);
  });

  test("a coverage floor lowered BY the rename is still caught", () => {
    const { root, write } = preMergeRepo();
    writeMerged(write, {
      coverage: { approvedDeviation: "seed", "packages/a/**": { lines: 40 } },
    });
    const errors = run(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /coverage floor .* decreased 90 → 40/u);
  });

  test("a budget widened BY the rename is still caught", () => {
    const { root, write } = preMergeRepo();
    writeMerged(write, {
      suiteWallClock: {
        approvedDeviation: "seed",
        lanes: { "pr-vitest": { budgetMs: 9999 } },
      },
    });
    assert.match(run(root)[0], /widened 1000 → 9999/u);
  });
});

describe("waiver scope", () => {
  test("a section's own CHANGED approvedDeviation waives its own widen", () => {
    const { root, write } = preMergeRepo();
    writeMerged(write, {
      suiteWallClock: {
        approvedDeviation: "seed + a reviewed widen (#915)",
        lanes: { "pr-vitest": { budgetMs: 9999 } },
      },
    });
    assert.deepEqual(run(root), []);
  });

  test("it does NOT waive a neighbouring section's floor drop", () => {
    const { root, write } = preMergeRepo();
    writeMerged(write, {
      suiteWallClock: {
        approvedDeviation: "seed + a reviewed widen (#915)",
        lanes: { "pr-vitest": { budgetMs: 9999 } },
      },
      coverage: { approvedDeviation: "seed", "packages/a/**": { lines: 40 } },
    });
    const errors = run(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /tests\/floors\.json#coverage/u);
  });
});

describe("issue and expiry", () => {
  test("an exception with no expiry fails", () => {
    const { root, write } = preMergeRepo();
    writeMerged(write, { skip: { "a.ts#1": { issue: 1 } } });
    assert.match(run(root)[0], /has no expiry/u);
  });

  test("an expiry in the past fails", () => {
    const { root, write } = preMergeRepo();
    writeMerged(write, {
      skip: { "a.ts#1": { issue: 1, expires: "2020-01-01" } },
    });
    assert.match(run(root)[0], /expired on 2020-01-01/u);
  });

  test("an env-red style revisitTrigger substitutes for a date", () => {
    const { root, write } = preMergeRepo();
    writeMerged(write, {
      skip: { "a.ts#1": { issue: 1, revisitTrigger: "when the rig lands" } },
    });
    assert.deepEqual(run(root), []);
  });

  test("a lane park with no issue fails", () => {
    const { root, write } = preMergeRepo();
    writeMerged(write, {
      lanes: { "mobile-e2e-ios": { expires: "2099-01-01" } },
    });
    assert.match(run(root)[0], /has no issue/u);
  });
});

describe("derived mirrors", () => {
  test("a minimumTests mirror that drifts from the claims file fails", () => {
    const { root, write } = preMergeRepo();
    writeMerged(write, { minimumTests: { f1: 3 } });
    assert.match(run(root)[0], /mirrors tests\/claims\.json as 4 but reads 3/u);
  });

  test("a mobile suite mirror that drifts from the roster fails", () => {
    const { root, write } = preMergeRepo();
    writeMerged(write, { mobileSuites: { "pr-gate": 900_000 } });
    const errors = run(root);
    assert.match(errors[0], /mirrors tests\/agent-e2e-mobile\/roster\.json/u);
  });

  test("the mirrors are read off their sources, not hand-typed", () => {
    assert.deepEqual(minimumTestsMirror(CLAIMS), { f1: 4 });
    assert.deepEqual(mobileSuitesMirror(ROSTER), { "pr-gate": 480_000 });
  });
});

describe("budgetNumbers", () => {
  test("an inventory row's line and issue are not budgets", () => {
    const section = { budget: "_budget" };
    const value = { _budget: 3, sites: { "a.ts#1": { line: 900, issue: 42 } } };
    assert.deepEqual(budgetNumbers(section, value), { _budget: 3 });
  });

  test("a named sub-object is flattened", () => {
    assert.deepEqual(
      budgetNumbers({ budget: "lanes" }, { lanes: { a: { budgetMs: 5 } } }),
      { "a.budgetMs": 5 }
    );
  });
});

describe("shapeLegacy", () => {
  test("the advisory file becomes the section's steps map", () => {
    assert.deepEqual(shapeLegacy("advisory", { _comment: "x", "a: b": {} }), {
      steps: { "a: b": {} },
    });
  });

  test("the empty design-token budget file becomes an empty budgets map", () => {
    assert.deepEqual(shapeLegacy("designTokenCss", {}), { budgets: {} });
  });
});

describe("serializeLedger", () => {
  test("an all-number array that fits stays on one line", () => {
    assert.equal(
      serializeLedger({ files: { "a.ts": [1, 2] } }),
      '{\n  "files": {\n    "a.ts": [1, 2]\n  }\n}\n'
    );
  });

  test("an all-number array that does not fit is FILLED, not exploded", () => {
    const key = `x/${"y".repeat(70)}.ts`;
    const out = serializeLedger({ files: { [key]: [1085, 5299] } });
    assert.match(out, /\[\n {6}1085, 5299\n {4}\]/u);
  });

  test("the trailing comma counts toward the 80-column budget", () => {
    // Exactly the boundary the pins hit: 80 columns without a comma, 81 with.
    const key = "apps/desktop/src/main/gateway-monitor-notifications.test.ts";
    // At the pins' real depth (inventory → commentDensity → files) the entry
    // is 80 columns bare and 81 with its comma, so only the non-final one wraps.
    const out = serializeLedger({
      commentDensity: { files: { [key]: [267, 2828], z: [1, 2] } },
    });
    assert.match(out, /notifications\.test\.ts": \[\n {8}267, 2828\n {6}\],/u);
  });
});
