#!/usr/bin/env node
// MOBILE SUITE BUDGETS — the ratchet that turns derived arithmetic into measured
// p95 (issue #890 W4).
//
// Every mobile suite budget shipped by #890 is derived rather than observed, and
// each budget doc says so and promises the same thing: "the moment this lane
// produces three real runs, re-derive from the observed p95 and TIGHTEN". That
// promise, written five times in five markdown files, is exactly the kind of
// thing nobody does. This is the thing that does it.
//
// Two rules, and the asymmetry between them is the point:
//
//   RULE tighten-only   A suite's BUDGET_MS may never rise. Reading the previous
//     value from the merge base makes the ceiling a one-way ratchet, so "the
//     lane got slow" can never be answered by widening the budget — which is the
//     one answer that always works and always costs the gate its meaning.
//
//   RULE p95-slack      Once the ledger holds MIN_SAMPLES real runs of a suite's
//     members, a budget more than SLACK× the observed p95 FAILS. A ceiling
//     nothing has ever come close to is not a budget; it is a number that will
//     be true forever, which is the same as no gate at all. The remedy is to
//     lower it, and the failure message says the number to lower it to.
//
// It is a NO-OP until the ledger has data, deliberately: seeding a ratchet from
// zero samples would pin the derived guesses as if they were measurements, which
// is the failure `tests/mutation-floors.json` records as its own worst case.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const MOBILE_DIR = "tests/agent-e2e-mobile";
const LEDGER_PATH = `${MOBILE_DIR}/ledger/durations.json`;

// Three real runs, matching what every #890 budget doc promises and what
// tests/coverage-floors.json's `sustainedRuns` already uses for the same
// question: how many observations before a number stops being an anecdote.
const MIN_SAMPLES = 3;
// A budget may sit at most 1.5x above the observed p95. Wide enough that a
// slow runner does not red the lane; narrow enough that the ceiling still
// describes the suite. Deliberately the same multiplier as the rig drift gate
// (`rigDriftBudgetMs`), because it answers the same question.
const SLACK = 1.5;

/** `{ name, budgetMs, flows }` for every committed suite runner. */
export function readRunners(root = ROOT) {
  const dir = path.resolve(root, MOBILE_DIR);
  return readdirSync(dir)
    .filter((name) => /^run-[\w.-]+\.mjs$/u.test(name))
    .sort()
    .map((name) => {
      const source = readFileSync(path.join(dir, name), "utf8");
      const budget = /^const BUDGET_MS = (?<minutes>[\d_]+) \* 60_000/mu.exec(
        source
      );
      const flows = /^const FLOWS\s*=\s*\[(?<body>[\s\S]*?)\]/mu.exec(source);
      return {
        file: `${MOBILE_DIR}/${name}`,
        budgetMs: budget
          ? Number(budget.groups.minutes.replaceAll("_", "")) * 60_000
          : null,
        flows: flows
          ? [
              ...flows.groups.body.matchAll(/["'](?<flow>[\w.-]+\.mjs)["']/gu),
            ].map((m) => m.groups.flow)
          : [],
      };
    });
}

/** Nearest-rank p95 — the same definition `lib/run-ledger.mjs` uses. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

/**
 * The observed cost of one suite: for each run of the suite we have no direct
 * record (the ledger records FLOWS, not suites), so the suite's cost is
 * reconstructed as the sum of its members' p95s. That over-estimates — the
 * members' worst runs did not all happen together — which is the safe direction
 * for a ceiling: it can only make this gate more permissive, never wrongly red.
 * Stated here rather than left for a reader to infer from the arithmetic.
 */
export function observedSuiteMs(runner, byFlow) {
  const parts = runner.flows.map((flow) => byFlow.get(flow) ?? []);
  if (parts.some((samples) => samples.length < MIN_SAMPLES)) return null;
  return parts.reduce((total, samples) => total + percentile(samples, 95), 0);
}

/** Durations per flow basename, passing runs only — a failed run's duration is
 * the time it took to fail, which is not the cost of the journey. */
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

/** The previous BUDGET_MS for a runner on the merge base, or null when the file
 * is new or no base ref resolves (a fresh clone, a detached CI checkout). */
function baseBudgetMs(file) {
  for (const ref of ["origin/main", "main"]) {
    try {
      const source = execFileSync("git", ["show", `${ref}:${file}`], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const match = /^const BUDGET_MS = (?<minutes>[\d_]+) \* 60_000/mu.exec(
        source
      );
      return match
        ? Number(match.groups.minutes.replaceAll("_", "")) * 60_000
        : null;
    } catch {
      // Try the next ref; a missing file on the base is a new suite, not an error.
    }
  }
  return null;
}

export function checkBudgets({ runners, byFlow, baseOf }) {
  const findings = [];
  for (const runner of runners) {
    if (runner.budgetMs == null) {
      findings.push(
        `${runner.file} declares no BUDGET_MS. Every suite owes an aggregate ceiling — ` +
          `a roster nothing prices is a roster that can grow without anyone deciding to spend it.`
      );
      continue;
    }
    const base = baseOf(runner.file);
    if (base != null && runner.budgetMs > base) {
      findings.push(
        `${runner.file} raises BUDGET_MS from ${base / 60_000} to ${runner.budgetMs / 60_000} ` +
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
  const runners = readRunners();
  if (runners.length === 0) {
    console.error(
      `\nFAIL — found zero suite runners under ${MOBILE_DIR}. The roster moved or was deleted.\n`
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
    `ok   mobile-suite-budgets — ${runners.length} suite(s), tighten-only; ` +
      `${measured} measured against ledger p95, ${runners.length - measured} still on the ` +
      `derived ceiling their budget doc admits to`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
