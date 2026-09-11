/**
 * Deterministically-environment-red inventory (#781).
 *
 * The class this covers sits between the two existing ledgers: the flake
 * quarantine owns NONdeterministic failures and the skip budget owns declared
 * skips, so a test that fails EVERY time in a known environment — the
 * wal-shipper [G4] chmod injection that root ignored, fixed as an instance in
 * #782 — had no inventory, no expiry, and no gate. The mechanism decided here
 * is a hybrid, not a quarantine kind: quarantining excludes the owner from the
 * required checks everywhere, which deletes live coverage on every environment
 * where the test is green to silence the one where it is red. Instead the test
 * must carry an ENV GUARD (`skipIf(predicate)` or a runtime `t.skip`), which
 * makes it honest at runtime everywhere — red becomes a visible, reported skip
 * — and the guard site must be inventoried HERE, which makes the class
 * visible: `tests/inventory.json#envRed` records the environment predicate, the guard
 * mechanism, an open issue, and an expiry or revisit trigger, under a
 * down-only budget.
 *
 * The guard site itself is also a skip site, so it independently lands in
 * `tests/inventory.json#skips` — that budget counts holes; this one records WHY the hole
 * is environment-shaped and when to look again. What no static scan can find
 * is the UNguarded instance (G4's chmod named no platform or uid), so the
 * contract is: the moment such a red is diagnosed, the fix is either an
 * environment-independent rewrite (as #782 did) or a guard — and a guard
 * cannot land uninventoried, because this gate scans for environment
 * predicates (`process.platform` / `process.arch` / `process.getuid` /
 * `process.geteuid` comparisons) in test files exactly as skip-inventory scans
 * for skips.
 */

import { glob, readFile } from "node:fs/promises";
import path from "node:path";

import {
  INVENTORY_PATH,
  readLedgerSection,
  writeLedgerSection,
} from "../check-ledgers.mjs";
import { parseDay } from "./quarantine.ts";
import { dict, finite, fromAsync } from "./record.ts";
import { SCAN_EXCLUDE, SCAN_INCLUDE } from "./skip-inventory.ts";

const root = path.resolve(import.meta.dirname, "../..");

/**
 * Ordered detectors; the first match on a line wins so one line yields exactly
 * one site. Comparisons only: `platform: process.platform` in an evidence
 * payload, `expect(x).toBe(os.platform())` as an env-relative expected value,
 * and a `process.geteuid = () => 0` mock are not environment guards.
 */
export const ENV_GUARD_PATTERNS = [
  {
    kind: "platform-guard",
    pattern: /process\.platform\s*[!=]==?|[!=]==?\s*process\.platform/u,
  },
  {
    kind: "arch-guard",
    pattern: /process\.arch\s*[!=]==?|[!=]==?\s*process\.arch/u,
  },
  {
    kind: "uid-guard",
    pattern:
      /process\.gete?uid(?:\?\.)?\(\)\s*(?:[!=]==?|[<>]=?)|(?:[!=]==?|[<>]=?)\s*process\.gete?uid(?:\?\.)?\(\)/u,
  },
];

/** How an inventoried site keeps its test honest in the red environment. */
export const GUARD_MECHANISMS = new Set([
  // `test.skipIf(predicate)` / `describe.skipIf` / `runIf` — collection-time.
  "skipIf",
  // `t.skip("reason")` inside the test body — reported to the runner.
  "runtime-skip",
  // The test still runs but asserts strictly less in the red environment
  // (e.g. latency without the fsync count off linux). Not mechanically
  // checkable; the `environment` sentence must say what is not asserted.
  "reduced-assertion",
  // The inverse arm: in the environment where the evidence MUST exist, a
  // missing prerequisite throws instead of skipping into a false green.
  "hard-fail",
]);

/** Mechanical cross-checks for the guard mechanisms that have one. */
const GUARD_EVIDENCE = new Map([
  ["skipIf", /\b\w+\.(?:skipIf|runIf)\s*\(/u],
  ["runtime-skip", /\b(?:t|ctx|context)\.skip\s*\(/u],
]);

/** Extract every environment-guard site in one file. Pure. */
export function scanEnvGuardSites(file: string, source: string) {
  if (typeof source !== "string" || !source) return [];
  const sites: Record<string, unknown>[] = [];
  const lines = source.split("\n");
  for (const [index, line] of lines.entries()) {
    const detector = ENV_GUARD_PATTERNS.find((entry) =>
      entry.pattern.test(line)
    );
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

/**
 * Walk the SAME globs skip-inventory scans (one population, two ledgers) and
 * return every environment-guard site plus the source of each file that has
 * one, so validation can check that the inventoried test names still exist.
 */
export async function discoverEnvGuardSites({
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
    [...files].sort().map(async (file) => ({
      file,
      source: await readFile(path.join(cwd, file), "utf8").catch(() => null),
    }))
  );
  const sites: Record<string, unknown>[] = [];
  const sources: Record<string, unknown> = {};
  for (const { file, source } of scanned) {
    if (source === null) continue;
    const found = scanEnvGuardSites(file, source);
    if (!found.length) continue;
    sites.push(...found);
    sources[file] = source;
  }
  return { sites, sources };
}

/**
 * Check the discovered population against the committed inventory.
 *
 * `nowMs` is a parameter rather than a `Date.now()` call so the gate's own
 * tests can prove the expiry boundary instead of asserting around it.
 */
export function validateEnvRedInventory(
  inventory: unknown,
  sites: unknown[],
  {
    trackingIssues = {},
    sources = {},
    nowMs,
  }: {
    trackingIssues?: unknown;
    sources?: unknown;
    nowMs?: unknown;
  } = {}
) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const entries = dict(dict(inventory).sites);
  const sourceMap = dict(sources);
  const issueMap = dict(trackingIssues);
  const discovered = new Map(
    sites.map((raw) => {
      const site = dict(raw);
      return [String(site.key), site] as const;
    })
  );

  for (const raw of sites) {
    const site = dict(raw);
    const entry = dict(entries[String(site.key)]);
    if (!entries[String(site.key)]) {
      errors.push(
        `uninventoried env guard ${site.key} (line ${site.line}, ${site.kind}): a test that is deterministically red in some environment must be recorded in tests/env-red.json with the predicate, the guard, an issue, and an expiry or revisit trigger`
      );
      continue;
    }
    if (entry.kind !== site.kind) {
      errors.push(
        `env guard ${site.key} is inventoried as ${entry.kind} but is now ${site.kind}; re-inventory it`
      );
    }
    if (Number.isInteger(entry.line) && entry.line !== site.line) {
      warnings.push(
        `env guard ${site.key} moved from line ${entry.line} to ${site.line}; run scripts/test-report/env-red-inventory.mjs --write`
      );
    }
  }

  for (const [key, rawEntry] of Object.entries(entries)) {
    const entry = dict(rawEntry);
    const site = discovered.get(key);
    if (!site) {
      errors.push(
        `stale env-red entry ${key}: the guard (or its file) is gone, delete the entry and lower _budget`
      );
      continue;
    }
    const source = sourceMap[String(site.file)];
    const testNamed =
      typeof entry.test === "string" && entry.test.trim().length >= 4;
    if (!testNamed) {
      errors.push(
        `env-red ${key} needs \`test\` — a substring of the guarded test or describe title`
      );
    }
    if (
      testNamed &&
      typeof source === "string" &&
      !source.includes(String(entry.test))
    ) {
      errors.push(
        `env-red ${key}: test "${entry.test}" no longer exists in ${site.file} — the guarded test vanished or was renamed; fix the entry or delete it`
      );
    }
    if (
      typeof entry.environment !== "string" ||
      entry.environment.trim().length < 12
    ) {
      errors.push(
        `env-red ${key} has no usable \`environment\` (one sentence naming the environment where the unguarded test is red, and why)`
      );
    }
    if (typeof entry.guard === "string" && GUARD_MECHANISMS.has(entry.guard)) {
      const evidence = GUARD_EVIDENCE.get(entry.guard);
      if (evidence && typeof source === "string" && !evidence.test(source)) {
        errors.push(
          `env-red ${key} declares guard "${entry.guard}" but ${site.file} contains no such guard; the test is naked-red in its environment`
        );
      }
    } else {
      errors.push(
        `env-red ${key} needs \`guard\` — one of ${[...GUARD_MECHANISMS].join(", ")}`
      );
    }
    if (!Number.isInteger(entry.issue) || Number(entry.issue) < 1) {
      errors.push(`env-red ${key} cites no tracking issue`);
    } else {
      const record = dict(issueMap[String(entry.issue)]);
      if (!issueMap[String(entry.issue)]) {
        errors.push(
          `env-red ${key} cites issue #${entry.issue}, which is not registered in matrix.trackingIssues`
        );
      } else if (record.state !== "open") {
        errors.push(
          `env-red ${key} cites closed issue #${entry.issue}; retarget it to an open one`
        );
      }
    }
    const hasRevisit =
      typeof entry.revisitTrigger === "string" &&
      entry.revisitTrigger.trim().length >= 12;
    if (entry.expiresAt != null) {
      const until = parseDay(entry.expiresAt);
      if (until === null) {
        errors.push(`env-red ${key}: \`expiresAt\` must be YYYY-MM-DD`);
      } else if (finite(nowMs) && until <= nowMs) {
        errors.push(
          `env-red ${key} EXPIRED on ${entry.expiresAt} — make the test environment-independent (the #782 wal-shipper move), renew with a reviewed edit, or delete the test with a receipt (#${entry.issue})`
        );
      }
    } else if (!hasRevisit) {
      errors.push(
        `env-red ${key} needs an \`expiresAt\` date or a \`revisitTrigger\` sentence — an environment hole with neither is parked forever`
      );
    }
  }

  const budget = dict(inventory)._budget;
  if (!Number.isInteger(budget)) {
    errors.push("tests/inventory.json#envRed has no integer _budget");
  } else if (sites.length > Number(budget)) {
    errors.push(
      `env-red budget exceeded: ${sites.length} guard sites against a budget of ${budget}. The budget is down-only — make a test environment-independent instead of raising it.`
    );
  } else if (sites.length < Number(budget)) {
    errors.push(
      `env-red budget is slack: ${sites.length} guard sites against a budget of ${budget}. Ratchet _budget down to ${sites.length}.`
    );
  }

  return { errors, warnings, count: sites.length };
}

/**
 * Rewrite the inventory in place: refresh lines/kinds/snippets, drop entries
 * whose guard is gone, and stub in new sites with null fields so validation
 * still fails until a human documents them. The budget is only ever LOWERED
 * here — a new environment hole must be paid for by editing `_budget` by hand.
 */
export function reconcileInventory(inventory: unknown, sites: unknown[]) {
  const previous = dict(dict(inventory).sites);
  const next: Record<string, unknown> = {};
  for (const raw of sites) {
    const site = dict(raw);
    const entry = dict(previous[String(site.key)]);
    next[String(site.key)] = {
      kind: site.kind,
      line: site.line,
      snippet: site.snippet,
      test: entry.test ?? "",
      environment: entry.environment ?? "",
      guard: entry.guard ?? null,
      issue: entry.issue ?? null,
      ...(entry.expiresAt != null && { expiresAt: entry.expiresAt }),
      revisitTrigger: entry.revisitTrigger ?? "",
    };
  }
  const currentBudget = dict(inventory)._budget;
  const budget = Number.isInteger(currentBudget)
    ? Math.min(Number(currentBudget), sites.length)
    : sites.length;
  return { ...dict(inventory), _budget: budget, sites: next };
}

async function main() {
  const write = process.argv.includes("--write");
  const { sites, sources } = await discoverEnvGuardSites({ root });
  const inventory = readLedgerSection(INVENTORY_PATH, "envRed", root) ?? {
    _budget: sites.length,
    sites: {},
  };
  if (write) {
    const next = reconcileInventory(inventory, sites);
    writeLedgerSection(INVENTORY_PATH, "envRed", next, root);
    console.log(
      `env-red: wrote ${sites.length} sites (budget ${next._budget}) to ${INVENTORY_PATH}#envRed`
    );
    return;
  }
  const matrix = JSON.parse(
    await readFile(path.join(root, "tests/claims.json"), "utf8")
  );
  const { errors, warnings, count } = validateEnvRedInventory(
    inventory,
    sites,
    { trackingIssues: matrix.trackingIssues, sources, nowMs: Date.now() }
  );
  for (const warning of warnings) console.warn(`env-red: warning: ${warning}`);
  if (errors.length) {
    for (const error of errors) console.error(`env-red: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `env-red: ${count} inventoried environment-guard sites, budget ${count}`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  await main();
}
