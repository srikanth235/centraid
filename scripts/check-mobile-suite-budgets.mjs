#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { loadRoster } from "../tests/agent-e2e-mobile/lib/roster.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const MOBILE_DIR = "tests/agent-e2e-mobile";
const LEDGER_PATH = `${MOBILE_DIR}/ledger/durations.json`;

const MIN_SAMPLES = 3;
const SLACK = 1.5;

export function readSuites(roster = loadRoster()) {
  return Object.entries(roster.suites ?? {}).map(([id, spec]) => ({
    id,
    file: `${MOBILE_DIR}/roster.json#suites.${id}`,
    budgetMs: typeof spec.budgetMs === "number" ? spec.budgetMs : null,
    flows: spec.flows ?? [],
    supersedes: spec.supersedes,
  }));
}

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

export function observedSuiteMs(runner, byFlow) {
  const parts = runner.flows.map((flow) => byFlow.get(flow) ?? []);
  if (parts.some((samples) => samples.length < MIN_SAMPLES)) return null;
  return parts.reduce((total, samples) => total + percentile(samples, 95), 0);
}

export function groupByFlow(ledger) {
  const byFlow = new Map();
  for (const record of ledger.records ?? []) {
    if (record.pass !== true) continue;
    const flow = path.posix.basename(record.flow ?? record.slug ?? "");
    const key = flow.endsWith(".mjs") ? flow : `${flow}.mjs`;
    if (!byFlow.has(key)) byFlow.set(key, []);
    byFlow.get(key).push(record.durationMs);
  }
  return byFlow;
}

function showAt(ref, file) {
  try {
    return execFileSync("git", ["show", `${ref}:${file}`], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

export function baseBudgetMs(suite, supersedes, show = showAt) {
  for (const ref of ["origin/main", "main"]) {
    const roster = show(ref, `${MOBILE_DIR}/roster.json`);
    if (roster) {
      const parsed = JSON.parse(roster);
      const base = parsed.suites?.[suite]?.budgetMs;
      if (typeof base === "number") return base;
      const inherited = supersedes && parsed.suites?.[supersedes]?.budgetMs;
      if (typeof inherited === "number") return inherited;
    }
    const candidates = [suite, supersedes]
      .filter(Boolean)
      .flatMap((id) => [`run-${id}-suite.mjs`, `run-${id}.mjs`]);
    for (const candidate of candidates) {
      const source = show(ref, `${MOBILE_DIR}/${candidate}`);
      const match =
        source &&
        /^const BUDGET_MS = (?<minutes>[\d_]+) \* 60_000/mu.exec(source);
      if (match)
        return Number(match.groups.minutes.replaceAll("_", "")) * 60_000;
    }
  }
  return null;
}

export function checkBudgets({ runners, byFlow, baseOf }) {
  const findings = [];
  for (const runner of runners) {
    if (runner.budgetMs == null) {
      findings.push(
        `${runner.file} declares no budgetMs. Every suite owes an aggregate ceiling — ` +
          `a roster nothing prices is a roster that can grow without anyone deciding to spend it.`
      );
      continue;
    }
    const base = baseOf(runner.id ?? runner.file, runner.supersedes);
    if (base != null && runner.budgetMs > base) {
      findings.push(
        `${runner.file} raises budgetMs from ${base / 60_000} to ${runner.budgetMs / 60_000} ` +
          `minutes. These ceilings are TIGHTEN-ONLY: a slow lane is fixed by moving a claim ` +
          `down a tier or batching its chunks, never by widening the number that was supposed ` +
          `to notice.`
      );
    }
    const observed = observedSuiteMs(runner, byFlow);
    if (observed == null) continue; // fewer than MIN_SAMPLES; still a derived guess
    const ceiling = Math.ceil((observed * SLACK) / 60_000);
    if (runner.budgetMs / 60_000 > ceiling) {
      findings.push(
        `${runner.file} budgets ${runner.budgetMs / 60_000} minutes against an observed ` +
          `p95 of ~${Math.ceil(observed / 60_000)} minutes across its members. The ledger has ` +
          `${MIN_SAMPLES}+ real runs now, so the derived guess has served its purpose: ` +
          `re-derive and TIGHTEN to ${ceiling} minutes. A ceiling nothing has ever come close ` +
          `to is not a budget.`
      );
    }
  }
  return findings;
}

function selfTest() {
  const byFlow = new Map([
    ["a.mjs", [60_000, 60_000, 60_000]],
    ["b.mjs", [60_000, 60_000]],
  ]);
  const runner = (budgetMinutes, flows) => ({
    file: "r.mjs",
    budgetMs: budgetMinutes * 60_000,
    flows,
  });
  const cases = [
    {
      name: "no samples yet — the derived guess stands",
      runners: [runner(30, ["b.mjs"])],
      baseOf: () => null,
      want: 0,
    },
    {
      name: "a wildly slack budget with enough samples is flagged",
      runners: [runner(30, ["a.mjs"])],
      baseOf: () => null,
      want: 1,
    },
    {
      name: "a budget inside the slack is clean",
      runners: [runner(2, ["a.mjs"])],
      baseOf: () => null,
      want: 0,
    },
    {
      name: "a raised budget is flagged even with no samples",
      runners: [runner(30, ["b.mjs"])],
      baseOf: () => 12 * 60_000,
      want: 1,
    },
    {
      name: "a lowered budget is clean",
      runners: [runner(1, ["b.mjs"])],
      baseOf: () => 12 * 60_000,
      want: 0,
    },
    {
      name: "a runner with no BUDGET_MS is flagged",
      runners: [{ file: "r.mjs", budgetMs: null, flows: [] }],
      baseOf: () => null,
      want: 1,
    },
  ];
  for (const testCase of cases) {
    const got = checkBudgets({ ...testCase, byFlow }).length;
    if (got !== testCase.want) {
      console.error(
        `FAIL — check-mobile-suite-budgets self-test "${testCase.name}": expected ${testCase.want} finding(s), got ${got}`
      );
      process.exit(1);
    }
  }
}

function main() {
  selfTest();
  const runners = readSuites();
  if (runners.length === 0) {
    console.error(
      `\nFAIL — ${MOBILE_DIR}/roster.json declares zero suites. The roster moved or was deleted.\n`
    );
    process.exit(1);
  }
  const ledger = JSON.parse(
    readFileSync(path.resolve(ROOT, LEDGER_PATH), "utf8")
  );
  const byFlow = groupByFlow(ledger);
  const findings = checkBudgets({ runners, byFlow, baseOf: baseBudgetMs });

  if (findings.length > 0) {
    console.error(
      `\nFAIL — ${findings.length} mobile suite budget defect(s):\n`
    );
    for (const finding of findings) console.error(`  ${finding}\n`);
    process.exit(1);
  }

  const measured = runners.filter(
    (r) => observedSuiteMs(r, byFlow) != null
  ).length;
  console.log(
    `ok   mobile-suite-budgets — ${runners.length} suite(s) from roster.json, tighten-only; ` +
      `${measured} measured against ledger p95, ${runners.length - measured} still on the ` +
      `derived ceiling their budget doc admits to`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
