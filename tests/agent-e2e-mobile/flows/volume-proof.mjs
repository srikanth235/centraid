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
  const volumeYaml = `appId: ${ctx.state.appId}
---
- repeat:
    times: ${ITERATIONS}
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
  try {
    await ctx.run(volumeYaml, "mobile-volume");
  } catch (error) {
    // iOS XCTest can report the app stopped during a rapid relaunch batch even
    // though the next launch is healthy. Retry once so a driver hiccup does
    // not erase the volume sample; a real product crash fails again here.
    if (ctx.state.platform !== "ios") throw error;
    ctx.note("iOS volume batch hit a transient app-stop; retrying once");
    await ctx.run(volumeYaml, "mobile-volume-retry");
  }
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
