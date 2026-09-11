/**
 * The skip budget (#656 Layer 2).
 *
 * Every deliberate hole in the suite — `test.skip`, `describe.skipIf`, `.todo`,
 * a runtime `t.skip()`, or a `CENTRAID_*` / `CLAWGNITION_*` env gate — is a
 * quality claim the author gets to make by hand. So it is the one thing agents
 * are still allowed to declare, and the price of declaring it is an inventory
 * entry in `tests/inventory.json#skips` citing an open tracking issue, a
 * reason, and a date by which the hole is closed or re-argued (#915 Wave 4).
 *
 * Two mechanical consequences:
 *   - an UNINVENTORIED skip fails `check:pr` (it cannot be added quietly), and
 *   - the total is a DOWN-ONLY ratchet: `_budget` must always equal the
 *     discovered count, so removing a skip permanently lowers the ceiling and
 *     adding one is impossible without editing the budget in the same change.
 *
 * Sites are keyed `<path>#<ordinal>` (ordinal = nth skip site in that file) so
 * the key survives the line drift that any edit above it would cause.
 */

import { glob, readFile } from "node:fs/promises";
import path from "node:path";

import {
  INVENTORY_PATH,
  readLedgerSection,
  writeLedgerSection,
} from "../check-ledgers.mjs";
import { bags, dict, fromAsync, items, type Loose } from "./record.ts";

const root = path.resolve(import.meta.dirname, "../..");

// The deadline a newly inventoried skip carries when nothing more specific is
// known (#915 Wave 4). Every hole in the suite now has a date by which it is
// closed or re-argued; `lint:ledgers` fails on a past one.
const DEFAULT_EXPIRY = "2026-12-01";

/**
 * Ordered detectors; the first match on a line wins so one line yields exactly
 * one site and the kind is deterministic.
 */
export const SKIP_PATTERNS = [
  { kind: "static-skip", pattern: /\b(?:test|it|describe|suite)\.skip\s*\(/u },
  { kind: "todo", pattern: /\b(?:test|it|describe|suite)\.todo\s*\(/u },
  { kind: "conditional-skip", pattern: /\b\w+\.(?:skipIf|runIf)\s*\(/u },
  { kind: "runtime-skip", pattern: /\b(?:t|ctx|context)\.skip\s*\(/u },
  // An opt-in gate: the suite (or its strictness) is off unless the flag is
  // set. `!== "1"` is always a gate; `=== "1"` counts only when it names a gate
  // variable, so an `if (FLAG === "1") console.info(...)` diagnostic is not
  // mistaken for a hole in the suite.
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

/** Globs scanned for skip sites. Test files only — src is not a skip surface. */
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
  // Recursive: a script test one directory down (`scripts/gateway-package/`,
  // `apps/mobile/scripts/`) is a test like any other, and a single-segment glob
  // silently exempted it from the budget — an invisible skip is the exact
  // failure this gate exists to prevent.
  "scripts/**/*.test.mjs",
  "apps/*/scripts/**/*.test.mjs",
];

/**
 * `scripts/test-report/**` is excluded on purpose: those files are the skip
 * DETECTORS, and their fixtures quote every pattern above as string literals.
 * Inventorying a detector's own test data would make the budget meaningless.
 */
export const SCAN_EXCLUDE = ["node_modules/", "dist/", "scripts/test-report/"];

/** Extract every skip site in one file. Pure. */
export function scanSkipSites(file: string, source: string) {
  if (typeof source !== "string" || !source) return [];
  const sites: Record<string, unknown>[] = [];
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

/** Walk the scan globs and return every skip site in the repository. */
export async function discoverSkipSites({
  root: cwd = root,
  include = SCAN_INCLUDE,
  exclude = SCAN_EXCLUDE,
}: { root?: string; include?: string[]; exclude?: string[] } = {}) {
  const matched = await Promise.all(
    include.map((pattern) => fromAsync(glob(pattern, { cwd })))
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

/**
 * Check the discovered population against the committed inventory.
 * `trackingIssues` is `matrix.trackingIssues` — a skip must cite an issue that
 * is registered there and still open.
 */
export function validateSkipInventory(
  inventory: unknown,
  sites: unknown,
  { trackingIssues = {} }: { trackingIssues?: unknown } = {}
) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const bag = dict(inventory);
  const entries = dict(bag.sites);
  const discoveredSites = bags(sites);
  const discovered = new Map(
    discoveredSites.map((site) => [String(site.key ?? ""), site])
  );
  const issues = dict(trackingIssues);

  for (const site of discoveredSites) {
    const key = String(site.key ?? "");
    if (!(key in entries)) {
      errors.push(
        `uninventoried skip ${site.key} (line ${site.line}, ${site.kind}): add it to tests/inventory.json#skips with an issue, a reason and an expires date, or delete the skip`
      );
      continue;
    }
    const entry = dict(entries[key]);
    if (entry.kind !== site.kind) {
      errors.push(
        `skip ${site.key} is inventoried as ${entry.kind} but is now ${site.kind}; re-inventory it`
      );
    }
    if (!Number.isInteger(entry.issue) || Number(entry.issue) < 1) {
      errors.push(`skip ${site.key} cites no tracking issue`);
    } else {
      const record = dict(issues[String(entry.issue)]);
      if (!(String(entry.issue) in issues)) {
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

  const budget = bag._budget;
  if (!Number.isInteger(budget)) {
    errors.push("tests/inventory.json#skips has no integer _budget");
  } else if (discoveredSites.length > Number(budget)) {
    errors.push(
      `skip budget exceeded: ${discoveredSites.length} skips against a budget of ${budget}. The budget is down-only — delete a skip instead of raising it.`
    );
  } else if (discoveredSites.length < Number(budget)) {
    errors.push(
      `skip budget is slack: ${discoveredSites.length} skips against a budget of ${budget}. Ratchet _budget down to ${discoveredSites.length}.`
    );
  }

  return { errors, warnings, count: discoveredSites.length };
}

/**
 * Rewrite the inventory in place: refresh lines/kinds/snippets, drop entries
 * whose skip is gone, and stub in new sites with a null issue so validation
 * still fails until a human cites one. The budget is only ever LOWERED here —
 * a new skip must be paid for by editing `_budget` by hand.
 */
export function reconcileInventory(inventory: unknown, sites: unknown) {
  const bag = dict(inventory);
  const previous = dict(bag.sites);
  const next: Record<string, unknown> = {};
  const discoveredSites = bags(sites);
  for (const site of discoveredSites) {
    const key = String(site.key ?? "");
    const entry = dict(previous[key]);
    next[key] = {
      kind: site.kind,
      line: site.line,
      snippet: site.snippet,
      issue: entry.issue ?? null,
      reason: entry.reason ?? "",
      // The deadline #915 Wave 4 gave every inventory exception. `--write`
      // carries it through rather than reseeding it, so a re-scan never
      // silently extends a hole's life.
      expires: entry.expires ?? DEFAULT_EXPIRY,
    };
  }
  const budget = Number.isInteger(bag._budget)
    ? Math.min(Number(bag._budget), discoveredSites.length)
    : discoveredSites.length;
  return { ...bag, _budget: budget, sites: next };
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
  const matrix = dict(
    JSON.parse(
      await readFile(path.join(root, "tests/claims.json"), "utf8")
    ) as unknown
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
