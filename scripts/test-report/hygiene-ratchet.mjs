import { glob, readFile } from "node:fs/promises";
import path from "node:path";

import {
  INVENTORY_PATH,
  readLedgerSection,
  writeLedgerSection,
} from "../check-ledgers.mjs";

const root = path.resolve(import.meta.dirname, "../..");

export const METRICS = {
  toBeTruthyFalsy: {
    label: "toBeTruthy/toBeFalsy",
    pattern: /\.toBe(?:Truthy|Falsy)\s*\(/gu,
    remedy:
      "assert the value: expect(x).toBe(true) / toBe(false), or a specific matcher",
  },
  toHaveBeenCalled: {
    label: "toHaveBeenCalled* (excluding .not.toHaveBeenCalled())",
    pattern:
      /\.(?<negated>not\s*\.\s*)?toHaveBeenCalled(?<suffix>[A-Za-z]*)\s*\(/gu,
    remedy:
      "assert the observable outcome the call produced, not that the mock ran",
  },
};

export const SCAN_INCLUDE = ["**/*.test.ts", "**/*.test.tsx"];

export const SCAN_EXCLUDE = [
  "node_modules/",
  "dist/",
  "build/",
  "scripts/test-report/",
];

export const METRIC_KEYS = Object.keys(METRICS);

export function countHygieneSites(source) {
  const counts = Object.fromEntries(METRIC_KEYS.map((key) => [key, 0]));
  if (typeof source !== "string" || !source) return counts;

  counts.toBeTruthyFalsy = [
    ...source.matchAll(METRICS.toBeTruthyFalsy.pattern),
  ].length;

  for (const match of source.matchAll(METRICS.toHaveBeenCalled.pattern)) {
    const negated = Boolean(match.groups.negated);
    const suffix = match.groups.suffix;
    if (negated && suffix === "") continue;
    counts.toHaveBeenCalled += 1;
  }
  return counts;
}

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

export function topOffenders(files, key, limit = 5) {
  return files
    .filter((entry) => entry[key] > 0)
    .sort((a, b) => b[key] - a[key] || a.file.localeCompare(b.file))
    .slice(0, limit)
    .map((entry) => `${entry.file} (${entry[key]})`);
}

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
