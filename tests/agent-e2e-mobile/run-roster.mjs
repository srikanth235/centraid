#!/usr/bin/env node
// THE ONE MOBILE SUITE RUNNER (#915 Wave 2).
//
//   node tests/agent-e2e-mobile/run-roster.mjs --rung <2|3|4|5> --platform <android|ios> \
//        [--suite <id>] [--dry-run]
//
// It replaces seven `run-*-suite.mjs` files that differed only in three
// literals. Those literals are now rows in `roster.json` — which is also where
// the rung, the platform, the claim and the per-flow budget live, so "what does
// this lane run" and "what does the ledger claim" are one document instead of
// four that nothing held against each other.
//
// WHY THE FLAGS ARE THE INTERFACE, and not an env var or a suite name alone.
// `scripts/lint-e2e-wiring.mjs` derives what a lane schedules by reading the
// invocation the shipped workflow or shell script actually contains. A runner
// selected by `CENTRAID_MOBILE_SUITE=$SOMETHING` would make every lane look
// identical to that linter, which is the exact property its `promoting` and
// `exploratory` rules depend on (a `promoting` flow may never reach a blocking
// lane). Flags are the thing a text-scanning gate can read, so the flags ARE
// the wiring. `--dry-run` prints the resolved plan as JSON for the same reason:
// the linter and the runner then answer the question with the same code.
//
// ONE SUITE PER INVOCATION when `--suite` is given; otherwise every suite that
// rung and platform selects, IN ROSTER ORDER, with per-suite exit codes
// collected rather than short-circuited — the `set +e; ec=0; … || ec=$?` shape
// the roster shell used to carry, moved here so a mid-roster failure still
// cannot grey the suites behind it (#535 F4).

import { plan, PLATFORMS, RUNGS, validateRoster } from "./lib/roster.mjs";
import { runSuite } from "./lib/run-suite.mjs";

/** Minimal flag parsing — no dependency, and every flag is `--name value`. */
export function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    const value = argv[i + 1];
    if (arg === "--rung") {
      out.rung = Number(value);
      i += 1;
      continue;
    }
    if (arg === "--platform") {
      out.platform = value;
      i += 1;
      continue;
    }
    if (arg === "--suite") {
      out.suite = value;
      i += 1;
      continue;
    }
    throw new Error(
      `run-roster: unrecognised argument "${arg}". Usage: --rung <n> --platform <android|ios> [--suite <id>] [--dry-run]`
    );
  }
  if (!RUNGS.includes(out.rung))
    throw new Error(
      `run-roster: --rung must be one of ${RUNGS.join(", ")}, got "${out.rung}"`
    );
  if (!PLATFORMS.includes(out.platform))
    throw new Error(
      `run-roster: --platform must be one of ${PLATFORMS.join(", ")}, got "${out.platform}"`
    );
  return out;
}

/**
 * Resolve the plan and refuse an empty one.
 *
 * A silent no-op is a FAILURE here for the same reason it is in every linter in
 * this repo: a lane that selects nothing looks exactly like a lane that passed,
 * and `--suite` naming a suite that does not sit on this rung is the way that
 * happens by accident.
 */
export function resolvePlan({ rung, platform, suite }, roster) {
  const entries = plan({ rung, platform, suite, roster });
  if (entries.length === 0) {
    throw new Error(
      suite
        ? `run-roster: suite "${suite}" is not on rung ${rung} for ${platform}. A lane that schedules nothing reads exactly like a lane that passed.`
        : `run-roster: no suite sits on rung ${rung} for ${platform}. A lane that schedules nothing reads exactly like a lane that passed.`
    );
  }
  return entries;
}

/**
 * Run every suite in the plan, collecting exit codes.
 *
 * Exported so the seven compatibility shims delegate here rather than each
 * re-deriving the plan, and so the unit suite can drive the collection rule
 * with a stub in place of `runSuite`.
 */
export async function runPlan(entries, run = runSuite) {
  let exitCode = 0;
  for (const entry of entries) {
    // Sequential on purpose: the suites share ONE device and ONE gateway, so
    // `Promise.all` would be wrong rather than faster. Same reasoning as the
    // member loop in lib/run-suite.mjs.
    // oxlint-disable-next-line no-await-in-loop -- one device, strictly serial (#915)
    const code = await run({
      name: entry.suite,
      flows: entry.flows.map((flow) => flow.file),
      budgetMs: entry.budgetMs,
      lane: entry.lane,
      ...(entry.platform.length === 1 ? { platform: entry.platform[0] } : {}),
      canaryCount: entry.canaryCount,
      reuseAfter: entry.reuseAfter,
      onBudgetBreach: entry.onBudgetBreach,
    });
    if (code !== 0) exitCode = code;
  }
  return exitCode;
}

async function main(argv) {
  const args = parseArgs(argv);
  // The roster is the only input, so a roster that contradicts itself is a
  // runner that lies about what it ran. Checked before anything boots.
  const defects = validateRoster();
  if (defects.length > 0) {
    console.error(
      `\nFAIL — ${defects.length} defect(s) in tests/agent-e2e-mobile/roster.json:\n`
    );
    for (const defect of defects) console.error(`  ${defect}\n`);
    return 1;
  }
  const entries = resolvePlan(args);
  if (args.dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          rung: args.rung,
          platform: args.platform,
          suites: entries.map((entry) => ({
            suite: entry.suite,
            budgetMs: entry.budgetMs,
            lane: entry.lane,
            flows: entry.flows.map((flow) => flow.path),
          })),
        },
        undefined,
        2
      )}\n`
    );
    return 0;
  }
  console.error(
    `[roster] rung ${args.rung} / ${args.platform}: ${entries
      .map((entry) => `${entry.suite} (${entry.flows.length})`)
      .join(", ")}`
  );
  return runPlan(entries);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2)).catch((error) => {
    console.error(`\nFAIL — ${error.message}\n`);
    return 1;
  });
}
