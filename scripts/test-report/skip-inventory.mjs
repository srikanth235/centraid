import { glob, readFile } from "node:fs/promises";
import path from "node:path";

import {
  INVENTORY_PATH,
  readLedgerSection,
  writeLedgerSection,
} from "../check-ledgers.mjs";

const root = path.resolve(import.meta.dirname, "../..");

const DEFAULT_EXPIRY = "2026-12-01";

export const SKIP_PATTERNS = [
  { kind: "static-skip", pattern: /\b(?:test|it|describe|suite)\.skip\s*\(/u },
  { kind: "todo", pattern: /\b(?:test|it|describe|suite)\.todo\s*\(/u },
  { kind: "conditional-skip", pattern: /\b\w+\.(?:skipIf|runIf)\s*\(/u },
  { kind: "runtime-skip", pattern: /\b(?:t|ctx|context)\.skip\s*\(/u },
  {
    kind: "env-gate",
    pattern:
      /process\.env\.(?:CENTRAID|CLAWGNITION)_[A-Z0-9_]+\s*!==\s*["']1["']/u,
  },
  {
    kind: "env-gate",
    pattern:
      /\b(?:const|let|var)\s+\w+\s*=[^=]*process\.env\.(?:CENTRAID|CLAWGNITION)_[A-Z0-9_]+\s*===\s*["']1["']/u,
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

export const SCAN_EXCLUDE = ["node_modules/", "dist/", "scripts/test-report/"];

export function scanSkipSites(file, source) {
  if (typeof source !== "string" || !source) return [];
  const sites = [];
  const lines = source.split("\n");
  for (const [index, line] of lines.entries()) {
    const detector = SKIP_PATTERNS.find((entry) => entry.pattern.test(line));
    if (!detector) continue;
    sites.push({
      key: `${file}#${sites.length + 1}`,
      file,
      ordinal: sites.length + 1,
      line: index + 1,
      kind: detector.kind,
      snippet: line.trim().slice(0, 120),
    });
  }
  return sites;
}

export async function discoverSkipSites({
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
      return source === null ? [] : scanSkipSites(file, source);
    })
  );
  return scanned.flat();
}

export function validateSkipInventory(
  inventory,
  sites,
  { trackingIssues = {} } = {}
) {
  const errors = [];
  const warnings = [];
  const entries = inventory?.sites ?? {};
  const discovered = new Map(sites.map((site) => [site.key, site]));

  for (const site of sites) {
    const entry = entries[site.key];
    if (!entry) {
      errors.push(
        `uninventoried skip ${site.key} (line ${site.line}, ${site.kind}): add it to tests/inventory.json#skips with an issue, a reason and an expires date, or delete the skip`
      );
      continue;
    }
    if (entry.kind !== site.kind) {
      errors.push(
        `skip ${site.key} is inventoried as ${entry.kind} but is now ${site.kind}; re-inventory it`
      );
    }
    if (!Number.isInteger(entry.issue) || entry.issue < 1) {
      errors.push(`skip ${site.key} cites no tracking issue`);
    } else {
      const record = trackingIssues[String(entry.issue)];
      if (!record) {
        errors.push(
          `skip ${site.key} cites issue #${entry.issue}, which is not registered in matrix.trackingIssues`
        );
      } else if (record.state !== "open") {
        errors.push(
          `skip ${site.key} cites closed issue #${entry.issue}; remove the skip or retarget it`
        );
      }
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 12) {
      errors.push(
        `skip ${site.key} has no usable reason (one sentence naming what cannot run and why)`
      );
    }
    if (Number.isInteger(entry.line) && entry.line !== site.line) {
      warnings.push(
        `skip ${site.key} moved from line ${entry.line} to ${site.line}; run scripts/test-report/skip-inventory.mjs --write`
      );
    }
  }

  for (const key of Object.keys(entries)) {
    if (!discovered.has(key)) {
      errors.push(
        `stale skip inventory entry ${key}: the skip is gone, delete the entry and lower _budget`
      );
    }
  }

  const budget = inventory?._budget;
  if (!Number.isInteger(budget)) {
    errors.push("tests/inventory.json#skips has no integer _budget");
  } else if (sites.length > budget) {
    errors.push(
      `skip budget exceeded: ${sites.length} skips against a budget of ${budget}. The budget is down-only — delete a skip instead of raising it.`
    );
  } else if (sites.length < budget) {
    errors.push(
      `skip budget is slack: ${sites.length} skips against a budget of ${budget}. Ratchet _budget down to ${sites.length}.`
    );
  }

  return { errors, warnings, count: sites.length };
}

export function reconcileInventory(inventory, sites) {
  const previous = inventory?.sites ?? {};
  const next = {};
  for (const site of sites) {
    const entry = previous[site.key] ?? {};
    next[site.key] = {
      kind: site.kind,
      line: site.line,
      snippet: site.snippet,
      issue: entry.issue ?? null,
      reason: entry.reason ?? "",
      expires: entry.expires ?? DEFAULT_EXPIRY,
    };
  }
  const budget = Number.isInteger(inventory?._budget)
    ? Math.min(inventory._budget, sites.length)
    : sites.length;
  return { ...inventory, _budget: budget, sites: next };
}

async function main() {
  const write = process.argv.includes("--write");
  const sites = await discoverSkipSites({ root });
  const inventory = readLedgerSection(INVENTORY_PATH, "skips", root) ?? {
    _budget: sites.length,
    sites: {},
  };
  if (write) {
    const next = reconcileInventory(inventory, sites);
    writeLedgerSection(INVENTORY_PATH, "skips", next, root);
    console.log(
      `skips: wrote ${sites.length} sites (budget ${next._budget}) to ${INVENTORY_PATH}#skips`
    );
    return;
  }
  const matrix = JSON.parse(
    await readFile(path.join(root, "tests/claims.json"), "utf8")
  );
  const { errors, warnings, count } = validateSkipInventory(inventory, sites, {
    trackingIssues: matrix.trackingIssues,
  });
  for (const warning of warnings) console.warn(`skips: warning: ${warning}`);
  if (errors.length) {
    for (const error of errors) console.error(`skips: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`skips: ${count} inventoried skip sites, budget ${count}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  await main();
}
