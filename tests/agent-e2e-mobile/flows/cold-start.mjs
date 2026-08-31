import path from "node:path";

import {
  recordQualityResult,
  rigDriftBudget,
} from "../../agent-e2e-shared/harness.mjs";
import { HOME_READY_MARKER, runFlow } from "../lib/harness.mjs";

/**
 * PER-LAUNCH mobile cold start (issue #659 R3c).
 *
 * `volume-proof.mjs` already relaunches the app 20 times, but it times the
 * whole repeat block as ONE wall clock: a single 10-second launch disappears
 * into a 20-launch sum, and nobody can read the number as an experience. This
 * flow launches the app one chunk at a time and reports the distribution —
 * median and p95 of the interval a person actually waits, from tapping the
 * icon to Home being ready.
 *
 * NO ABSOLUTE CEILING. An on-device number from a CI simulator has no
 * distribution yet, and a guessed ceiling would either fence nothing or red the
 * mobile lane on simulator jitter. The gate is the sustained-drift budget every
 * other rig now uses (30 samples, 1.5x the trailing median — the knobs live in
 * tests/quality-rig-budgets.json). An absolute ceiling lands in
 * tests/experience-budgets/mobile.json once the distribution exists.
 *
 * Year-3 declared volume (docs/coding-standards.md D6): NOT MET. These launches
 * run against whatever the e2e first-run flow seeded — effectively an empty
 * device-local replica, not the declared year-3 volume (50,000 replica rows;
 * see tests/experience-budgets/README.md). So this bounds the app's own boot
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

function commandText(command) {
  return JSON.stringify(command?.command ?? command?.evaluatedCommand ?? "");
}

function commandTime(command) {
  const timestamp = Number(command?.metadata?.timestamp);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function measuredLaunches(reports) {
  const commands = reports.flatMap((report) =>
    Array.isArray(report.commands) ? report.commands : []
  );
  const starts = commands
    .filter(
      (command) =>
        command?.metadata?.status === "COMPLETED" &&
        commandText(command).includes("launchApp")
    )
    .map(commandTime)
    .filter((timestamp) => timestamp !== undefined)
    .sort((left, right) => left - right);
  const homes = commands
    .filter(
      (command) =>
        command?.metadata?.status === "COMPLETED" &&
        commandText(command).includes(HOME_READY_MARKER)
    )
    .map(commandTime)
    .filter((timestamp) => timestamp !== undefined)
    .sort((left, right) => left - right);

  return starts
    .map((startedAt, index) => {
      const nextStart = starts[index + 1] ?? Number.POSITIVE_INFINITY;
      const home = homes.find(
        (completedAt) => completedAt >= startedAt && completedAt < nextStart
      );
      return home === undefined ? undefined : home - startedAt;
    })
    .filter((duration) => duration !== undefined && duration >= 0);
}

await runFlow("mobile-cold-start", async (ctx) => {
  // Home only exists behind onboarding since #603, and this flow never clears
  // state again after this point — so establish the paired state first and let
  // every launch below measure a warm-install, cold-process start, which is
  // what a person does every morning.
  await ctx.configureGateway();

  // Sequential by construction: each sample must be a cold process start on an
  // idle device, so these cannot be parallelised. Submit the flow files together
  // so Maestro keeps one XCUITest driver alive; every file still stops and
  // relaunches the app, preserving the independent process boundary without
  // paying the driver handshake eight times.
  const reports = await ctx.runSession(
    Array.from({ length: LAUNCHES }, (_, index) => ({
      label: `cold-start-${index + 1}`,
      yaml: `appId: ${ctx.state.appId}
---
- stopApp
- launchApp
- extendedWaitUntil:
    visible:
      text: "${HOME_READY_MARKER}"
    timeout: 30000
`,
    })),
    "cold-start-samples"
  );
  const launchMs = measuredLaunches(reports);
  if (launchMs.length !== LAUNCHES) {
    throw new Error(
      `cold-start session produced ${launchMs.length}/${LAUNCHES} timing receipts`
    );
  }

  const sorted = [...launchMs].sort((left, right) => left - right);
  const medianMs = percentile(sorted, 0.5);
  const p95Ms = percentile(sorted, 0.95);
  const slowestMs = sorted.at(-1);

  // The recorded history keys off measurements[0], so the MEDIAN is the series
  // the drift budget tracks: a p95 from eight samples on a shared CI simulator
  // is one unlucky launch away from noise, and a drift gate on noise is a gate
  // people learn to ignore.
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
