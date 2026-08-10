import path from "node:path";

import {
  qualityRegressionBudget,
  recordQualityResult,
} from "../../agent-e2e-shared/harness.mjs";
import {
  indentMaestroCommands,
  relaunchDevClientCommands,
  waitForHomeReadyCommands,
} from "../lib/first-run.mjs";
import {
  FIRST_LAUNCH_TIMEOUT_MS,
  HOME_READY_MARKER,
  runFlow,
} from "../lib/harness.mjs";

const OWNER = "tests/agent-e2e-mobile/flows/volume-proof.mjs";
const ITERATIONS = 20;
const BATCH_SIZE = 5;
const BATCHES = Math.ceil(ITERATIONS / BATCH_SIZE);
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

await runFlow("mobile-volume-proof", async (ctx) => {
  // Home only exists behind onboarding since #603, and this flow's own repeat
  // loop never clears state — so it has to establish the paired state itself
  // rather than inherit whatever a previously-run flow happened to leave on the
  // device. configureGateway clears state, redeems a one-time ticket and lands
  // on Home; every relaunch below then measures a warm, paired launch.
  await ctx.configureGateway();
  const started = performance.now();
  // The outer launchApp keeps the paired dev client's Metro route warm. Do not
  // reissue the custom-scheme handoff for every iteration: iOS 26 can time out
  // simctl openurl even when the cached server card is healthy.
  const warmRelaunchCommands = relaunchDevClientCommands(ctx.state.platform, {
    useDeepLink: false,
  });
  const volumeYaml = (iterations) => `appId: ${ctx.state.appId}
---
- repeat:
    times: ${iterations}
    commands:
      - stopApp
      - launchApp:
          clearState: false
${indentMaestroCommands(warmRelaunchCommands, 6)}${indentMaestroCommands(waitForHomeReadyCommands(FIRST_LAUNCH_TIMEOUT_MS, ctx.state.platform), 6)}
      - extendedWaitUntil:
          visible:
            text: "${HOME_READY_MARKER}"
          timeout: 1000
`;
  // Keep the total proof at 20 launches, but give XCTest a fresh flow process
  // every five. A single 20-repeat flow accumulated stale iOS driver state
  // after 16 successful cycles in run 31353793751; its whole-flow retry then
  // started Expo at "Downloading 100%" instead of recovering Home. Batching
  // bounds that driver lifetime without weakening the per-launch Home check.
  const runBatch = async (batch) => {
    if (batch >= BATCHES) return;
    const iterations = Math.min(BATCH_SIZE, ITERATIONS - batch * BATCH_SIZE);
    const name = `mobile-volume-${batch + 1}`;
    const batchYaml = volumeYaml(iterations);
    try {
      await ctx.run(batchYaml, name);
    } catch (error) {
      // iOS XCTest can report the app stopped during a rapid relaunch batch
      // even though the next launch is healthy. Retry only this small batch so
      // a driver hiccup does not erase the volume sample; a real product crash
      // fails again here.
      if (ctx.state.platform !== "ios") throw error;
      ctx.note(
        `iOS volume batch ${batch + 1}/${BATCHES} hit a transient app-stop; retrying once`
      );
      await ctx.run(batchYaml, `${name}-retry`);
    }
    // The simulator is one serial device; recurse instead of running batches
    // concurrently (and avoid hiding that ordering behind a lint suppression).
    await runBatch(batch + 1);
  };
  await runBatch(0);
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
