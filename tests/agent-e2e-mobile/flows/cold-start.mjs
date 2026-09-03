import path from "node:path";

import {
  recordQualityResult,
  rigDriftBudget,
} from "../../agent-e2e-shared/harness.mjs";
import { AWAIT_LAUNCHER, runFlow } from "../lib/harness.mjs";

const OWNER = "tests/agent-e2e-mobile/flows/cold-start.mjs";
const LAUNCHES = 8;
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

function percentile(sorted, fraction) {
  const index = Math.min(
    sorted.length - 1,
    Math.floor(sorted.length * fraction)
  );
  return sorted[index];
}

await runFlow("mobile-cold-start", async (ctx) => {
  await ctx.configureGateway();
  await ctx.flush();

  const launchMs = [];
  const measureNext = async (index) => {
    if (index >= LAUNCHES) return;
    const started = performance.now();
    await ctx.run(
      `appId: ${ctx.state.appId}
---
- stopApp
- launchApp
# THE LAUNCHER, NOT THE BAND'S LABEL — icon-to-usable, not icon-to-band. The
# band's marker renders on the empty-vault DayOne screen too, so it used to stop
# the clock on a Home that could not open a single app, and did (cold-start.md
# has the run). Longer numbers, and no history invalidated: the drift budget
# stays inactive until thirty samples exist.
${AWAIT_LAUNCHER}`,
      `cold-start-${index + 1}`
    );
    launchMs.push(performance.now() - started);
    return measureNext(index + 1);
  };
  await measureNext(0);

  const sorted = [...launchMs].sort((left, right) => left - right);
  const medianMs = percentile(sorted, 0.5);
  const p95Ms = percentile(sorted, 0.95);
  const slowestMs = sorted.at(-1);

  const drift = await rigDriftBudget(REPO_ROOT, "scale", OWNER);
  const passed = drift == null || medianMs <= drift;

  await recordQualityResult(REPO_ROOT, {
    lane: "scale",
    owner: OWNER,
    name: `${LAUNCHES} per-launch cold starts to a ready Home`,
    status: passed ? "passed" : "failed",
    measurements: [
      {
        name: "median cold start",
        value: medianMs,
        unit: "ms",
        ...(drift == null ? {} : { budget: drift }),
      },
      { name: "p95 cold start", value: p95Ms, unit: "ms" },
      { name: "slowest cold start", value: slowestMs, unit: "ms" },
      { name: "launches", value: LAUNCHES, unit: "count" },
    ],
  });

  ctx.note(
    `cold start over ${LAUNCHES} launches: median ${Math.round(medianMs)} ms, ` +
      `p95 ${Math.round(p95Ms)} ms, slowest ${Math.round(slowestMs)} ms` +
      (drift == null
        ? " (drift budget inactive — fewer than 30 durable samples)"
        : ` (drift budget ${Math.round(drift)} ms)`)
  );

  return {
    pass: passed,
    notes: passed
      ? "per-launch cold start within its sustained-drift budget"
      : `median cold start ${Math.round(medianMs)} ms exceeded the drift budget ${Math.round(drift)} ms`,
  };
});
