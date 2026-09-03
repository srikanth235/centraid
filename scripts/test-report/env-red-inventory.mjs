import { glob, readFile } from "node:fs/promises";
import path from "node:path";

import {
  INVENTORY_PATH,
  readLedgerSection,
  writeLedgerSection,
} from "../check-ledgers.mjs";
import { parseDay } from "./quarantine.mjs";
import { SCAN_EXCLUDE, SCAN_INCLUDE } from "./skip-inventory.mjs";

const root = path.resolve(import.meta.dirname, "../..");

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

export const GUARD_MECHANISMS = new Set([
  "skipIf",
  "runtime-skip",
  "reduced-assertion",
  "hard-fail",
]);

const GUARD_EVIDENCE = new Map([
  ["skipIf", /\b\w+\.(?:skipIf|runIf)\s*\(/u],
  ["runtime-skip", /\b(?:t|ctx|context)\.skip\s*\(/u],
]);

export function scanEnvGuardSites(file, source) {
  if (typeof source !== "string" || !source) return [];
  const sites = [];
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

export async function discoverEnvGuardSites({
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
    [...files].sort().map(async (file) => ({
      file,
      source: await readFile(path.join(cwd, file), "utf8").catch(() => null),
    }))
  );
  const sites = [];
  const sources = {};
  for (const { file, source } of scanned) {
    if (source === null) continue;
    const found = scanEnvGuardSites(file, source);
    if (!found.length) continue;
    sites.push(...found);
    sources[file] = source;
  }
  return { sites, sources };
}

export function validateEnvRedInventory(
  inventory,
  sites,
  { trackingIssues = {}, sources = {}, nowMs } = {}
) {
  const errors = [];
  const warnings = [];
  const entries = inventory?.sites ?? {};
  const discovered = new Map(sites.map((site) => [site.key, site]));

  for (const site of sites) {
    const entry = entries[site.key];
    if (!entry) {
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

  for (const [key, entry] of Object.entries(entries)) {
    const site = discovered.get(key);
    if (!site) {
      errors.push(
        `stale env-red entry ${key}: the guard (or its file) is gone, delete the entry and lower _budget`
      );
      continue;
    }
    const source = sources[site.file];
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
      !source.includes(entry.test)
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
    if (GUARD_MECHANISMS.has(entry.guard)) {
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
    if (!Number.isInteger(entry.issue) || entry.issue < 1) {
      errors.push(`env-red ${key} cites no tracking issue`);
    } else {
      const record = trackingIssues[String(entry.issue)];
      if (!record) {
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
      } else if (Number.isFinite(nowMs) && until <= nowMs) {
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

  const budget = inventory?._budget;
  if (!Number.isInteger(budget)) {
    errors.push("tests/inventory.json#envRed has no integer _budget");
  } else if (sites.length > budget) {
    errors.push(
      `env-red budget exceeded: ${sites.length} guard sites against a budget of ${budget}. The budget is down-only — make a test environment-independent instead of raising it.`
    );
  } else if (sites.length < budget) {
    errors.push(
      `env-red budget is slack: ${sites.length} guard sites against a budget of ${budget}. Ratchet _budget down to ${sites.length}.`
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
      test: entry.test ?? "",
      environment: entry.environment ?? "",
      guard: entry.guard ?? null,
      issue: entry.issue ?? null,
      ...(entry.expiresAt != null && { expiresAt: entry.expiresAt }),
      revisitTrigger: entry.revisitTrigger ?? "",
    };
  }
  const budget = Number.isInteger(inventory?._budget)
    ? Math.min(inventory._budget, sites.length)
    : sites.length;
  return { ...inventory, _budget: budget, sites: next };
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
