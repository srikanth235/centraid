import { glob, readFile } from "node:fs/promises";
import path from "node:path";

import {
  INVENTORY_PATH,
  readLedgerSection,
  writeLedgerSection,
} from "../check-ledgers.mjs";

const root = path.resolve(import.meta.dirname, "../..");

export const SLEEP_PATTERNS = [
  {
    kind: "settimeout-literal",
    pattern: /\bsetTimeout\s*\(\s*[^;]*?,\s*(?<ms>\d[\d_]*)\s*\)/gu,
  },
  {
    kind: "sleep-helper",
    pattern: /\b(?:sleep|delay|pause)\s*\(\s*(?<ms>\d[\d_]*)\s*\)/gu,
  },
];

export const SCAN_INCLUDE = [
  "packages/*/src/**/*.test.ts",
  "packages/*/src/**/*.test.tsx",
  "packages/*/src/**/*.test.mjs",
  "packages/*/tests/**/*.test.ts",
  "apps/*/src/**/*.test.ts",
  "apps/*/src/**/*.test.tsx",
  "apps/*/tests/**/*.spec.ts",
  "apps/*/tests/**/*.test.ts",
  "tests/**/*.test.ts",
  "tests/**/*.test.mjs",
  "tests/agent-e2e-*/flows/*.mjs",
  "scripts/**/*.test.mjs",
  "apps/*/scripts/**/*.test.mjs",
];

export const SCAN_EXCLUDE = [
  "node_modules/",
  "dist/",
  "scripts/test-report/",
  "packages/test-kit/",
];

export function isWatchdog(matchedText) {
  return /\breject\b/u.test(matchedText);
}

export function countSleepSites(source) {
  if (typeof source !== "string" || !source) return 0;
  let count = 0;
  for (const { pattern } of SLEEP_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const ms = Number(match.groups.ms.replaceAll("_", ""));
      if (ms > 0 && !isWatchdog(match[0])) count += 1;
    }
  }
  return count;
}

export async function discoverSleepSites({
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
  const sites = {};
  const scanned = await Promise.all(
    [...files].sort().map(async (file) => {
      const source = await readFile(path.join(cwd, file), "utf8").catch(
        () => null
      );
      return { file, count: source === null ? 0 : countSleepSites(source) };
    })
  );
  for (const { file, count } of scanned) {
    if (count > 0) sites[file] = count;
  }
  return sites;
}

export function totalSites(sites) {
  return Object.values(sites ?? {}).reduce((sum, count) => sum + count, 0);
}

export function topOffenders(sites, limit = 5) {
  return Object.entries(sites)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([file, count]) => `${file} (${count})`);
}

const REMEDY =
  "replace the sleep with useFakeClock() + clock.advance(), an event-driven wait (vi.waitFor / a deferred the test resolves), or an outcome poll";

export function validateSleepInventory(inventory, sites) {
  const errors = [];
  const entries = inventory?.sites ?? {};

  for (const [file, count] of Object.entries(sites)) {
    const inventoried = entries[file];
    if (!Number.isInteger(inventoried)) {
      errors.push(
        `uninventoried fixed sleep(s): ${file} has ${count} site(s) not in tests/inventory.json#sleeps — ${REMEDY}, or inventory them`
      );
    } else if (count > inventoried) {
      errors.push(
        `${file} grew from ${inventoried} to ${count} fixed sleep site(s) — ${REMEDY}`
      );
    } else if (count < inventoried) {
      errors.push(
        `${file} is down to ${count} fixed sleep site(s) but inventoried at ${inventoried}; ratchet it (node scripts/test-report/sleep-inventory.mjs --write)`
      );
    }
  }

  for (const file of Object.keys(entries)) {
    if (!(file in sites)) {
      errors.push(
        `stale sleep inventory entry ${file}: the file has no fixed sleeps (or is gone); delete the entry and lower _budget`
      );
    }
  }

  const measured = totalSites(sites);
  const budget = inventory?._budget;
  if (!Number.isInteger(budget)) {
    errors.push("tests/inventory.json#sleeps has no integer _budget");
  } else if (measured > budget) {
    errors.push(
      `fixed-sleep budget exceeded: ${measured} sites against a budget of ${budget} (+${measured - budget}). The budget is down-only — ${REMEDY}. Top offenders: ${topOffenders(sites).join(", ")}`
    );
  } else if (measured < budget) {
    errors.push(
      `fixed-sleep budget is slack: ${measured} sites against a budget of ${budget}. Ratchet _budget down to ${measured} (node scripts/test-report/sleep-inventory.mjs --write).`
    );
  }

  return { errors, count: measured };
}

export function reconcileInventory(inventory, sites) {
  const measured = totalSites(sites);
  const budget = Number.isInteger(inventory?._budget)
    ? Math.min(inventory._budget, measured)
    : measured;
  return { ...inventory, _budget: budget, sites };
}

async function main() {
  const write = process.argv.includes("--write");
  const sites = await discoverSleepSites({ root });
  const inventory = readLedgerSection(INVENTORY_PATH, "sleeps", root) ?? {
    _budget: totalSites(sites),
    sites: {},
  };
  if (write) {
    const next = reconcileInventory(inventory, sites);
    writeLedgerSection(INVENTORY_PATH, "sleeps", next, root);
    console.log(
      `sleeps: wrote ${totalSites(sites)} sites in ${Object.keys(sites).length} files (budget ${next._budget}) to ${INVENTORY_PATH}#sleeps`
    );
    return;
  }
  const { errors, count } = validateSleepInventory(inventory, sites);
  if (errors.length) {
    for (const error of errors) console.error(`sleeps: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `sleeps: ${count} inventoried fixed-sleep sites in ${Object.keys(sites).length} files, budget ${count}`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  await main();
}
