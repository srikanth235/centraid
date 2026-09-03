#!/usr/bin/env node

import { plan, PLATFORMS, RUNGS, validateRoster } from "./lib/roster.mjs";
import { runSuite } from "./lib/run-suite.mjs";

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

export async function runPlan(entries, run = runSuite) {
  let exitCode = 0;
  for (const entry of entries) {
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
