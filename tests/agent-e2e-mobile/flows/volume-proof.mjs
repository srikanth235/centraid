import path from "node:path";

import {
  qualityRegressionBudget,
  recordQualityResult,
} from "../../agent-e2e-shared/harness.mjs";
import {
  FIRST_LAUNCH_TIMEOUT_MS,
  HOME_READY_MARKER,
  runFlow,
} from "../lib/harness.mjs";

const OWNER = "tests/agent-e2e-mobile/flows/volume-proof.mjs";
const ITERATIONS = 20;
const CHUNK_SIZE = 4;
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

await runFlow("mobile-volume-proof", async (ctx) => {
  // Home only exists behind onboarding since #603, and this flow's own repeat
  // loop never clears state — so it has to establish the paired state itself
  // rather than inherit whatever a previously-run flow happened to leave on the
  // device. configureGateway clears state, redeems a one-time ticket and lands
  // on Home; every relaunch below then measures a warm, paired launch. The
  // shared first-launch budget is intentionally used here too: the iOS cold
  // start probe has measured CI p95s near 90s, so a 30s volume assertion turns
  // simulator scheduling jitter into a false failure.
  await ctx.configureGateway();
  const started = performance.now();
  // Keep each Maestro session short. A single long iOS repeat can leave the
  // XCTest launch channel behind the app after several rapid relaunches (the
  // app was on its splash screen and then reported as not running in run
  // 30875656338). Fresh sessions preserve all 20 successful launch samples
  // while resetting the driver at a bounded interval; no assertion is made
  // optional and a real app crash still fails its chunk.
  const volumeFlow = (times) => `appId: ${ctx.state.appId}
---
- repeat:
    times: ${times}
    commands:
      # Maestro's launchApp already terminates the target before relaunching.
      # Keeping a separate stopApp here issued two terminate requests per
      # sample; on iOS that left the dev client on its splash and stopped before
      # XCTest could snapshot it (run 30831790904).
      - launchApp
      - extendedWaitUntil:
          visible:
            text: "${HOME_READY_MARKER}"
          timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
`;
  const runVolumeChunks = async (offset) => {
    if (offset >= ITERATIONS) return;
    const times = Math.min(CHUNK_SIZE, ITERATIONS - offset);
    await ctx.run(
      volumeFlow(times),
      `mobile-volume-${String(offset + 1).padStart(2, "0")}`
    );
    await runVolumeChunks(offset + CHUNK_SIZE);
  };
  await runVolumeChunks(0);
  const durationMs = performance.now() - started;
  const budget = await qualityRegressionBudget(REPO_ROOT, "scale", OWNER);
  const passed = budget == null || durationMs < budget;
  await recordQualityResult(REPO_ROOT, {
    lane: "scale",
    owner: OWNER,
    name: `${ITERATIONS} on-device Home relaunches`,
    status: passed ? "passed" : "failed",
    measurements: [
      {
        name: "wall clock",
        value: durationMs,
        unit: "ms",
        ...(budget == null ? {} : { budget }),
      },
      { name: "launches", value: ITERATIONS, unit: "count" },
    ],
  });
  ctx.note(`${ITERATIONS} on-device relaunches completed in ${durationMs}ms`);
  return {
    pass: passed,
    notes: "on-device volume proof completed",
  };
});
