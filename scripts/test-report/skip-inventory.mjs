/**
 * The skip budget (#656 Layer 2).
 *
 * Every deliberate hole in the suite — `test.skip`, `describe.skipIf`, `.todo`,
 * a runtime `t.skip()`, or a `CENTRAID_*` / `CLAWGNITION_*` env gate — is a
 * quality claim the author gets to make by hand. So it is the one thing agents
 * are still allowed to declare, and the price of declaring it is an inventory
 * entry in `tests/skips.json` citing an open tracking issue and a reason.
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

import { glob, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

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

/** Walk the scan globs and return every skip site in the repository. */
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

/**
 * Check the discovered population against the committed inventory.
 * `trackingIssues` is `matrix.trackingIssues` — a skip must cite an issue that
 * is registered there and still open.
 */
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
        `uninventoried skip ${site.key} (line ${site.line}, ${site.kind}): add it to tests/skips.json with an issue and a reason, or delete the skip`
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
    errors.push("tests/skips.json has no integer _budget");
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

/**
 * Rewrite the inventory in place: refresh lines/kinds/snippets, drop entries
 * whose skip is gone, and stub in new sites with a null issue so validation
 * still fails until a human cites one. The budget is only ever LOWERED here —
 * a new skip must be paid for by editing `_budget` by hand.
 */
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
    };
  }
  const budget = Number.isInteger(inventory?._budget)
    ? Math.min(inventory._budget, sites.length)
    : sites.length;
  return { ...inventory, _budget: budget, sites: next };
}

async function main() {
  const write = process.argv.includes("--write");
  const inventoryPath = path.join(root, "tests/skips.json");
  const sites = await discoverSkipSites({ root });
  let inventory;
  try {
    inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  } catch {
    inventory = { _budget: sites.length, sites: {} };
  }
  if (write) {
    const next = reconcileInventory(inventory, sites);
    await writeFile(inventoryPath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(
      `skips: wrote ${sites.length} sites (budget ${next._budget}) to tests/skips.json`
    );
    return;
  }
  const matrix = JSON.parse(
    await readFile(path.join(root, "tests/matrix.json"), "utf8")
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
