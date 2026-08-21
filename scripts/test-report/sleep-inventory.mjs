/**
 * The fixed-sleep budget (#781).
 *
 * A fixed sleep — `await new Promise((r) => setTimeout(r, 50))`, a
 * `setTimeout as sleep` alias, a local `delay(20)` helper — is a bet that the
 * awaited work finishes inside the literal, priced in flake on a loaded runner
 * and in wall clock everywhere else. TESTING.md's convention already says
 * "no real time"; principle 3 of the axiom says a convention without a machine
 * regresses. This is the machine, ratcheted the way the skip budget is:
 *
 *   - a fixed sleep in a file the inventory does not know about is a hard
 *     failure (it cannot be added quietly), and
 *   - the total is a DOWN-ONLY budget: over `_budget` fails with the remedy
 *     (fake clocks / event-driven waits), and under it fails telling you to
 *     ratchet the number down. `--write` reconciles and can only LOWER it.
 *
 * The gate counts textual sites; it does not time anything. A 1ms sleep and a
 * 5s sleep are each one site, because the defect is the *shape* — waiting on
 * the clock instead of on the event — not the current literal. 0ms yields
 * (`flushMacrotasks()` and friends) and fake-clock advances
 * (`clock.advance(n)`, `vi.advanceTimersByTime`) are not matched: neither
 * waits on real time.
 */

import { glob, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

/**
 * Ordered detectors; the first match wins per occurrence so a line yields a
 * deterministic kind. Every pattern captures the millisecond literal so 0ms
 * yields can be excluded — a sleep is only a sleep when it waits.
 */
export const SLEEP_PATTERNS = [
  // `setTimeout(<resolve|poll|() => …>, N)` with a literal N. This is the
  // promise-wrapped sleep, the poll-loop delay, and the timed fixture emission
  // in one shape. A non-literal delay (`setTimeout(r, timeoutMs)`) is not
  // matched: the budget covers hard-coded waits, not configurable ones. A
  // callback that REJECTS is skipped (see `isWatchdog`): a deadline like
  // `setTimeout(() => reject(new Error("timed out")), 10_000)` is the upper
  // bound on an event-driven wait — the test finishes on the event, not the
  // literal — which is the remedy this budget asks for, not the defect.
  {
    kind: "settimeout-literal",
    pattern: /\bsetTimeout\s*\(\s*[^;]*?,\s*(?<ms>\d[\d_]*)\s*\)/gu,
  },
  // Repo-local sleep helpers: `sleep(N)` (usually `setTimeout as sleep` from
  // node:timers/promises), `delay(N)`, `pause(N)`.
  {
    kind: "sleep-helper",
    pattern: /\b(?:sleep|delay|pause)\s*\(\s*(?<ms>\d[\d_]*)\s*\)/gu,
  },
];

/**
 * Globs scanned — the same test-file population the skip budget walks
 * (`skip-inventory.mjs`), because a fixed sleep is a quality hole in exactly
 * the same sense a skip is.
 */
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

/**
 * `scripts/test-report/**` is excluded for the reason the skip budget excludes
 * it: these are the detectors, and their fixtures quote the counted patterns
 * verbatim. `packages/test-kit/**` is excluded because the kit's own seam
 * tests must schedule literal timers under `useFakeClock()` to prove the fake
 * clock runs, jumps, and counts them — those never touch real time, which a
 * textual scan cannot see.
 */
export const SCAN_EXCLUDE = [
  "node_modules/",
  "dist/",
  "scripts/test-report/",
  "packages/test-kit/",
];

/** A rejecting deadline is a bound on an event-driven wait, not a sleep. */
export function isWatchdog(matchedText) {
  return /\breject\b/u.test(matchedText);
}

/** Count every fixed-sleep site in one file's source. Pure. */
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

/** Walk the scan globs and return `{file: count}` for files with sites. */
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

/** Total sites across the discovered (or inventoried) map. */
export function totalSites(sites) {
  return Object.values(sites ?? {}).reduce((sum, count) => sum + count, 0);
}

/** The worst files, formatted for a failure message (hygiene-ratchet style). */
export function topOffenders(sites, limit = 5) {
  return Object.entries(sites)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([file, count]) => `${file} (${count})`);
}

const REMEDY =
  "replace the sleep with useFakeClock() + clock.advance(), an event-driven wait (vi.waitFor / a deferred the test resolves), or an outcome poll";

/** Check the discovered population against the committed inventory. */
export function validateSleepInventory(inventory, sites) {
  const errors = [];
  const entries = inventory?.sites ?? {};

  for (const [file, count] of Object.entries(sites)) {
    const inventoried = entries[file];
    if (!Number.isInteger(inventoried)) {
      errors.push(
        `uninventoried fixed sleep(s): ${file} has ${count} site(s) not in tests/sleep-inventory.json — ${REMEDY}, or inventory them`
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
    errors.push("tests/sleep-inventory.json has no integer _budget");
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

/**
 * Rewrite the inventory in place: refresh per-file counts, drop files whose
 * sleeps are gone. The budget is only ever LOWERED here — a new sleep must be
 * paid for by raising `_budget` by hand, in a reviewed edit.
 */
export function reconcileInventory(inventory, sites) {
  const measured = totalSites(sites);
  const budget = Number.isInteger(inventory?._budget)
    ? Math.min(inventory._budget, measured)
    : measured;
  return { ...inventory, _budget: budget, sites };
}

async function main() {
  const write = process.argv.includes("--write");
  const inventoryPath = path.join(root, "tests/sleep-inventory.json");
  const sites = await discoverSleepSites({ root });
  let inventory;
  try {
    inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  } catch {
    inventory = { _budget: totalSites(sites), sites: {} };
  }
  if (write) {
    const next = reconcileInventory(inventory, sites);
    await writeFile(inventoryPath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(
      `sleeps: wrote ${totalSites(sites)} sites in ${Object.keys(sites).length} files (budget ${next._budget}) to tests/sleep-inventory.json`
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
