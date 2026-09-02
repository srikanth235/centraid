/**
 * The hygiene ratchet (#781).
 *
 * Two conventions in TESTING.md have no machine behind them, and principle 3
 * of the axiom says exactly what happens next: whatever is not mechanically
 * enforced will regress. It did — `toBeTruthy`/`toBeFalsy` went 304 -> 390 and
 * the `toHaveBeenCalled*` family ~600 -> 1,023 while the test-file population
 * grew about 20%. Both conventions were prose, and prose decays.
 *
 * Lint cannot own either one. `prefer-to-be-truthy` / `prefer-to-be-falsy` are
 * off on purpose (#573): their autofix runs the WRONG direction, rewriting the
 * house-style `toBe(true)` into the strictly weaker `toBeTruthy()`. And
 * `prefer-called-with` rewrites `toHaveBeenCalled()` to `toHaveBeenCalledWith()`
 * — an assertion that the mock was called with ZERO arguments. A rule that
 * makes the suite worse cannot be the enforcement.
 *
 * So the enforcement is a COUNT, ratcheted the way the skip budget is:
 *
 *   - measured > budget is a hard failure naming the top offender files, so a
 *     new `toBeTruthy()` cannot be added quietly; and
 *   - measured < budget is also a failure, because the budget must always
 *     equal the measured count. Improving the suite forces you to tighten the
 *     ceiling in the same change, which is what makes the direction down-only.
 *     `--write` does that reconciliation, and can only ever LOWER a budget.
 *
 * This gate counts; it does not read assertions. A file that swaps
 * `toBeTruthy()` for an equally vacuous `toBe(true)` passes. That judgement is
 * in TESTING.md's "What the machine cannot check" list, where it belongs.
 */

import { glob, readFile } from "node:fs/promises";
import path from "node:path";

import {
  INVENTORY_PATH,
  readLedgerSection,
  writeLedgerSection,
} from "../check-ledgers.mjs";

const root = path.resolve(import.meta.dirname, "../..");

/**
 * The measured metrics. Each is counted over whole file text (not per line) so
 * an assertion wrapped across lines by the formatter still counts.
 */
export const METRICS = {
  /**
   * `toBeTruthy()` / `toBeFalsy()`. TESTING.md: "Prefer specific matchers and
   * meaningful expected values over `toBeTruthy()`" — `toBeTruthy()` also
   * passes for `1`, `'x'`, `[]`, `{}`, so it asserts far less than it reads.
   */
  toBeTruthyFalsy: {
    label: "toBeTruthy/toBeFalsy",
    pattern: /\.toBe(?:Truthy|Falsy)\s*\(/gu,
    remedy:
      "assert the value: expect(x).toBe(true) / toBe(false), or a specific matcher",
  },
  /**
   * The `toHaveBeenCalled*` family, MINUS bare `.not.toHaveBeenCalled()`.
   *
   * TESTING.md: "Assert outcomes, not mock calls." But negated-bare is the one
   * legitimate shape and is deliberately exempt — there is no
   * `toHaveBeenCalledWith` equivalent of "never called", so naming arguments
   * there would WEAKEN the assertion (it would permit a call with different
   * arguments). QUALITY.md's #496 entry records the measurement behind that
   * carve-out: of 1,023 sites, all 186 bare ones were negated, and zero
   * positive bare calls remain. The chip-away is therefore against the
   * argument-bearing forms, which is what this metric counts.
   */
  toHaveBeenCalled: {
    label: "toHaveBeenCalled* (excluding .not.toHaveBeenCalled())",
    pattern:
      /\.(?<negated>not\s*\.\s*)?toHaveBeenCalled(?<suffix>[A-Za-z]*)\s*\(/gu,
    remedy:
      "assert the observable outcome the call produced, not that the mock ran",
  },
};

/**
 * Globs scanned. `**\/*.test.{ts,tsx}` is the population QUALITY.md measured
 * over on 2026-08-14, kept identical so the seeded budgets are reproducible.
 */
export const SCAN_INCLUDE = ["**/*.test.ts", "**/*.test.tsx"];

/**
 * `scripts/test-report/**` is excluded for the same reason the skip budget
 * excludes it: those files are the detectors, and their fixtures quote the
 * counted matchers verbatim. Counting a detector's own test data would make
 * the budget meaningless.
 */
export const SCAN_EXCLUDE = [
  "node_modules/",
  "dist/",
  "build/",
  "scripts/test-report/",
];

/** Every metric key, in stable order. */
export const METRIC_KEYS = Object.keys(METRICS);

/**
 * Count one file. Pure.
 * @param {string} source File contents.
 * @returns {Record<string, number>} Count per metric key.
 */
export function countHygieneSites(source) {
  const counts = Object.fromEntries(METRIC_KEYS.map((key) => [key, 0]));
  if (typeof source !== "string" || !source) return counts;

  counts.toBeTruthyFalsy = [
    ...source.matchAll(METRICS.toBeTruthyFalsy.pattern),
  ].length;

  for (const match of source.matchAll(METRICS.toHaveBeenCalled.pattern)) {
    const negated = Boolean(match.groups.negated);
    const suffix = match.groups.suffix;
    // Bare + negated is the exempt shape; every other combination counts.
    if (negated && suffix === "") continue;
    counts.toHaveBeenCalled += 1;
  }
  return counts;
}

/**
 * Walk the scan globs and count every test file in the repository.
 * @returns {Promise<{totals: Record<string, number>, files: Array<{file: string} & Record<string, number>>}>} Repo-wide totals per metric plus the per-file counts the failure message names offenders from.
 */
export async function discoverHygieneCounts({
  root: cwd = root,
  include = SCAN_INCLUDE,
  exclude = SCAN_EXCLUDE,
} = {}) {
  const matched = await Promise.all(
    include.map((pattern) => Array.fromAsync(glob(pattern, { cwd })))
  );
  const files = new Set(
    matched
      .flat()
      .map((match) => match.replaceAll("\\", "/"))
      .filter((file) => !exclude.some((skip) => file.includes(skip)))
  );
  const scanned = await Promise.all(
    [...files].sort().map(async (file) => {
      const source = await readFile(path.join(cwd, file), "utf8").catch(
        () => null
      );
      return { file, ...countHygieneSites(source) };
    })
  );
  const totals = Object.fromEntries(METRIC_KEYS.map((key) => [key, 0]));
  for (const entry of scanned) {
    for (const key of METRIC_KEYS) totals[key] += entry[key];
  }
  return { totals, files: scanned };
}

/**
 * The worst files for one metric, formatted for a failure message.
 * @param {Array<Record<string, number> & {file: string}>} files Per-file counts.
 * @param {string} key Metric key.
 * @param {number} limit How many to name.
 */
export function topOffenders(files, key, limit = 5) {
  return files
    .filter((entry) => entry[key] > 0)
    .sort((a, b) => b[key] - a[key] || a.file.localeCompare(b.file))
    .slice(0, limit)
    .map((entry) => `${entry.file} (${entry[key]})`);
}

/**
 * Check measured counts against the committed budgets.
 * @param {{budgets?: Record<string, number>}} budgets The inventory ledger's `hygiene` section.
 * @param {{totals: Record<string, number>, files: Array<object>}} discovered Scan result.
 */
export function validateHygieneBudgets(budgets, discovered) {
  const errors = [];
  const committed = budgets?.budgets ?? {};

  for (const key of METRIC_KEYS) {
    const measured = discovered.totals[key];
    const budget = committed[key];
    if (!Number.isInteger(budget)) {
      errors.push(
        `tests/inventory.json#hygiene has no integer budget for ${key}; seed it with the measured count (${measured})`
      );
      continue;
    }
    if (measured > budget) {
      const offenders = topOffenders(discovered.files, key);
      errors.push(
        `${METRICS[key].label} budget exceeded: ${measured} against a budget of ${budget} (+${measured - budget}). The budget is down-only — ${METRICS[key].remedy}. Top offenders: ${offenders.join(", ")}`
      );
    } else if (measured < budget) {
      errors.push(
        `${METRICS[key].label} budget is slack: ${measured} against a budget of ${budget}. Ratchet ${key} down to ${measured} (node scripts/test-report/hygiene-ratchet.mjs --write).`
      );
    }
  }

  for (const key of Object.keys(committed)) {
    if (!METRIC_KEYS.includes(key)) {
      errors.push(
        `tests/inventory.json#hygiene budgets an unknown metric ${key}; delete it or add a detector`
      );
    }
  }

  return { errors, totals: discovered.totals };
}

/**
 * Rewrite the budgets in place. A budget is only ever LOWERED here, so `--write`
 * cannot launder a regression: adding a `toBeTruthy()` still fails the gate
 * until someone raises the number by hand, in a reviewed edit.
 */
export function reconcileBudgets(budgets, totals) {
  const committed = budgets?.budgets ?? {};
  const next = {};
  for (const key of METRIC_KEYS) {
    const previous = committed[key];
    next[key] = Number.isInteger(previous)
      ? Math.min(previous, totals[key])
      : totals[key];
  }
  return { ...budgets, budgets: next };
}

async function main() {
  const write = process.argv.includes("--write");
  const discovered = await discoverHygieneCounts({ root });
  const budgets = readLedgerSection(INVENTORY_PATH, "hygiene", root) ?? {
    budgets: {},
  };

  if (write) {
    const next = reconcileBudgets(budgets, discovered.totals);
    writeLedgerSection(INVENTORY_PATH, "hygiene", next, root);
    console.log(
      `hygiene: wrote budgets ${METRIC_KEYS.map((key) => `${key}=${next.budgets[key]}`).join(" ")} to ${INVENTORY_PATH}#hygiene`
    );
    return;
  }

  const { errors, totals } = validateHygieneBudgets(budgets, discovered);
  if (errors.length) {
    for (const error of errors) console.error(`hygiene: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `hygiene: ${discovered.files.length} test files at budget — ${METRIC_KEYS.map((key) => `${METRICS[key].label} ${totals[key]}`).join(", ")}`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  await main();
}
