import path from "node:path";

import { recordQualityResult } from "../../agent-e2e-shared/harness.mjs";
import { AWAIT_LAUNCHER, runFlow } from "../lib/harness.mjs";

/**
 * PER-LAUNCH mobile cold start (issue #659 R3c).
 *
 * Launches the app one chunk at a time and reports the DISTRIBUTION — median
 * and p95 of the interval a person actually waits, from tapping the icon to
 * Home being ready. A repeat block timed as one wall clock cannot say that: a
 * single 10-second launch disappears into the sum, so the aggregate is
 * unreadable as an experience.
 *
 * NO ABSOLUTE CEILING. An on-device number from a CI simulator has no
 * distribution yet, and a guessed ceiling would either fence nothing or red the
 * mobile lane on simulator jitter. The gate is the sustained-drift budget every
 * other rig now uses (30 samples, 1.5x the trailing median — the knobs live in
 * tests/journeys.json#rigs). An absolute ceiling lands in
 * tests/journeys.json once the distribution exists.
 *
 * Year-3 declared volume (docs/coding-standards.md D6): NOT MET. These launches
 * run against whatever the e2e first-run flow seeded — effectively an empty
 * device-local replica, not the declared year-3 volume (50,000 replica rows;
 * see tests/journeys.json `volumes`). So this bounds the app's own boot
 * cost and CANNOT catch a launch that degrades with replica size. Closing that
 * needs the CI gateway to seed a year-3 replica before pairing.
 */
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
  // Home only exists behind onboarding since #603, and this flow never clears
  // state again after this point — so establish the paired state first and let
  // every launch below measure a warm-install, cold-process start, which is
  // what a person does every morning.
  await ctx.configureGateway();
  // A MEASURED LAUNCH CARRIES NOTHING BUT ITSELF. In reuse mode configureGateway
  // stages its launch onto the next chunk, and the next chunk here is sample one
  // — whose clock the drift budget reads. This flow is the one that pays the
  // extra Maestro spawn on purpose, so the staged launch runs on its own first.
  await ctx.flush();

  // Sequential by construction: each sample must be a cold process start on an
  // idle device, so these cannot be parallelised. Recursion rather than a loop
  // keeps that explicit (and satisfies no-await-in-loop, which is right to be
  // suspicious of every other shape).
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

  // The recorded history keys off measurements[0], so the MEDIAN is the series
  // Published, not gated (#927). Eight launches on a shared CI simulator is a
  // distribution, and the paired candidate/PR run is what compares two trees;
  // a threshold here would fence the runner.
  const passed = true;

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
      },
      { name: "p95 cold start", value: p95Ms, unit: "ms" },
      { name: "slowest cold start", value: slowestMs, unit: "ms" },
      { name: "launches", value: LAUNCHES, unit: "count" },
    ],
  });

  ctx.note(
    `cold start over ${LAUNCHES} launches: median ${Math.round(medianMs)} ms, ` +
      `p95 ${Math.round(p95Ms)} ms, slowest ${Math.round(slowestMs)} ms`
  );

  return {
    pass: passed,
    notes: passed
      ? "per-launch cold start distribution recorded"
      : "per-launch cold start could not be recorded",
  };
});
