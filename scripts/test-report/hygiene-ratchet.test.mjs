import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  METRIC_KEYS,
  SCAN_EXCLUDE,
  SCAN_INCLUDE,
  countHygieneSites,
  discoverHygieneCounts,
  reconcileBudgets,
  topOffenders,
  validateHygieneBudgets,
} from "./hygiene-ratchet.mjs";

const discovered = (totals, files = []) => ({ totals, files });

describe("countHygieneSites", () => {
  test("counts both truthiness matchers", () => {
    const source = [
      "expect(a).toBeTruthy();",
      "expect(b).toBeFalsy();",
      "expect(c).toBe(true);",
      "expect(d).toBeTruthy( );",
    ].join("\n");
    expect(countHygieneSites(source).toBeTruthyFalsy).toBe(3);
  });

  test("counts the whole toHaveBeenCalled family", () => {
    const source = [
      "expect(fn).toHaveBeenCalled();",
      "expect(fn).toHaveBeenCalledWith(1);",
      "expect(fn).toHaveBeenCalledTimes(2);",
      "expect(fn).toHaveBeenCalledOnce();",
      "expect(fn).toHaveBeenCalledOnceWith(1);",
      "expect(fn).toHaveBeenCalledExactlyOnceWith(1);",
    ].join("\n");
    expect(countHygieneSites(source).toHaveBeenCalled).toBe(6);
  });

  test("bare .not.toHaveBeenCalled() is exempt, negated-with is not", () => {
    // There is no toHaveBeenCalledWith equivalent of "never called", so naming
    // arguments in the negated-bare shape would WEAKEN the assertion — it would
    // start permitting a call with different arguments (QUALITY.md #496).
    expect(countHygieneSites("expect(fn).not.toHaveBeenCalled();")).toEqual({
      toBeTruthyFalsy: 0,
      toHaveBeenCalled: 0,
    });
    expect(
      countHygieneSites("expect(fn).not.toHaveBeenCalledWith(1);")
        .toHaveBeenCalled
    ).toBe(1);
    expect(
      countHygieneSites("expect(fn).not.toHaveBeenCalledTimes(3);")
        .toHaveBeenCalled
    ).toBe(1);
  });

  test("an assertion the formatter wrapped across lines still counts", () => {
    const wrapped = "expect(fn)\n  .not\n  .toHaveBeenCalled();";
    expect(countHygieneSites(wrapped).toHaveBeenCalled).toBe(0);
    const wrappedWith = "expect(fn)\n  .toHaveBeenCalledWith(\n    1\n  );";
    expect(countHygieneSites(wrappedWith).toHaveBeenCalled).toBe(1);
  });

  test("empty or non-string input counts zero rather than throwing", () => {
    expect(countHygieneSites("")).toEqual({
      toBeTruthyFalsy: 0,
      toHaveBeenCalled: 0,
    });
    expect(countHygieneSites(null).toHaveBeenCalled).toBe(0);
  });

  test("scan configuration covers test files and excludes the detectors", () => {
    expect(SCAN_INCLUDE).toEqual(["**/*.test.ts", "**/*.test.tsx"]);
    expect(SCAN_EXCLUDE).toContain("node_modules/");
    expect(SCAN_EXCLUDE).toContain("scripts/test-report/");
    expect(METRIC_KEYS).toEqual(["toBeTruthyFalsy", "toHaveBeenCalled"]);
  });
});

describe("discoverHygieneCounts", () => {
  /**
   * Write one file (creating parents) under a scratch root.
   * @param {string} root Scratch root.
   * @param {string} file Repo-relative path.
   * @param {string} source File contents.
   */
  function writeFixture(root, file, source) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, source);
  }

  test("totals across NESTED directories, both extensions", async () => {
    const root = tempDirSync("hygiene-ratchet-");
    writeFixture(root, "top.test.ts", "expect(a).toBeTruthy();");
    writeFixture(
      root,
      "packages/vault/src/deep/nested/thing.test.ts",
      "expect(a).toBeFalsy();\nexpect(fn).toHaveBeenCalledWith(1);"
    );
    writeFixture(
      root,
      "apps/mobile/src/screens/Screen.test.tsx",
      "expect(fn).toHaveBeenCalled();\nexpect(other).not.toHaveBeenCalled();"
    );
    // Not a test file: nothing here is counted.
    writeFixture(
      root,
      "packages/vault/src/thing.ts",
      "expect(a).toBeTruthy();"
    );

    const result = await discoverHygieneCounts({ root });
    expect(result.totals).toEqual({
      toBeTruthyFalsy: 2,
      toHaveBeenCalled: 2,
    });
    expect(result.files.map((entry) => entry.file)).toEqual([
      "apps/mobile/src/screens/Screen.test.tsx",
      "packages/vault/src/deep/nested/thing.test.ts",
      "top.test.ts",
    ]);
  });

  test("exempts node_modules and the detectors' own fixtures", async () => {
    const root = tempDirSync("hygiene-ratchet-");
    writeFixture(root, "node_modules/pkg/a.test.ts", "expect(a).toBeTruthy();");
    writeFixture(
      root,
      "scripts/test-report/detector.test.ts",
      "expect(a).toBeTruthy();"
    );
    const result = await discoverHygieneCounts({ root });
    expect(result.totals).toEqual({ toBeTruthyFalsy: 0, toHaveBeenCalled: 0 });
    expect(result.files).toEqual([]);
  });
});

describe("topOffenders", () => {
  test("names the worst files first, ties broken by path", () => {
    const files = [
      { file: "b.test.ts", toBeTruthyFalsy: 3, toHaveBeenCalled: 0 },
      { file: "a.test.ts", toBeTruthyFalsy: 3, toHaveBeenCalled: 0 },
      { file: "c.test.ts", toBeTruthyFalsy: 9, toHaveBeenCalled: 0 },
      { file: "d.test.ts", toBeTruthyFalsy: 0, toHaveBeenCalled: 4 },
    ];
    expect(topOffenders(files, "toBeTruthyFalsy", 2)).toEqual([
      "c.test.ts (9)",
      "a.test.ts (3)",
    ]);
  });
});

describe("validateHygieneBudgets", () => {
  test("accepts a population exactly at budget", () => {
    const { errors, totals } = validateHygieneBudgets(
      { budgets: { toBeTruthyFalsy: 2, toHaveBeenCalled: 5 } },
      discovered({ toBeTruthyFalsy: 2, toHaveBeenCalled: 5 })
    );
    expect(errors).toEqual([]);
    expect(totals.toHaveBeenCalled).toBe(5);
  });

  test("over budget is a hard failure naming the delta and the offenders", () => {
    const { errors } = validateHygieneBudgets(
      { budgets: { toBeTruthyFalsy: 1, toHaveBeenCalled: 5 } },
      discovered({ toBeTruthyFalsy: 4, toHaveBeenCalled: 5 }, [
        { file: "loud.test.ts", toBeTruthyFalsy: 3, toHaveBeenCalled: 0 },
        { file: "quiet.test.ts", toBeTruthyFalsy: 1, toHaveBeenCalled: 0 },
      ])
    );
    const joined = errors.join("\n");
    expect(joined).toContain("budget exceeded: 4 against a budget of 1 (+3)");
    expect(joined).toContain("loud.test.ts (3)");
    expect(joined).toContain("quiet.test.ts (1)");
  });

  test("under budget fails too, so an improvement tightens the ceiling", () => {
    // Mirrors the skip budget: the number must EQUAL the measured count, or
    // slack accumulates and the ratchet stops being down-only.
    const { errors } = validateHygieneBudgets(
      { budgets: { toBeTruthyFalsy: 2, toHaveBeenCalled: 9 } },
      discovered({ toBeTruthyFalsy: 2, toHaveBeenCalled: 4 })
    );
    expect(errors.join("\n")).toContain(
      "budget is slack: 4 against a budget of 9. Ratchet toHaveBeenCalled down to 4"
    );
  });

  test("a missing or non-integer budget fails with the measured seed", () => {
    const { errors } = validateHygieneBudgets(
      { budgets: { toBeTruthyFalsy: "413" } },
      discovered({ toBeTruthyFalsy: 413, toHaveBeenCalled: 840 })
    );
    expect(errors.join("\n")).toContain(
      "no integer budget for toBeTruthyFalsy"
    );
    expect(errors.join("\n")).toContain(
      "no integer budget for toHaveBeenCalled"
    );
  });

  test("a budget for a metric nothing measures fails instead of rotting", () => {
    const { errors } = validateHygieneBudgets(
      {
        budgets: {
          toBeTruthyFalsy: 0,
          toHaveBeenCalled: 0,
          toBeDefinedSomeday: 4,
        },
      },
      discovered({ toBeTruthyFalsy: 0, toHaveBeenCalled: 0 })
    );
    expect(errors.join("\n")).toContain(
      "budgets an unknown metric toBeDefinedSomeday"
    );
  });
});

describe("reconcileBudgets", () => {
  test("lowers to the measurement and never raises it", () => {
    const next = reconcileBudgets(
      {
        _comment: "kept",
        budgets: { toBeTruthyFalsy: 9, toHaveBeenCalled: 2 },
      },
      { toBeTruthyFalsy: 4, toHaveBeenCalled: 7 }
    );
    // Slack is taken up; a REGRESSION is not laundered — toHaveBeenCalled stays
    // at 2, so the gate keeps failing until someone raises it by hand.
    expect(next.budgets).toEqual({ toBeTruthyFalsy: 4, toHaveBeenCalled: 2 });
    expect(next._comment).toBe("kept");
  });

  test("seeds a missing budget from the measurement", () => {
    expect(
      reconcileBudgets({}, { toBeTruthyFalsy: 3, toHaveBeenCalled: 8 }).budgets
    ).toEqual({ toBeTruthyFalsy: 3, toHaveBeenCalled: 8 });
  });
});
