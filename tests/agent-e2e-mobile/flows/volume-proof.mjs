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
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- repeat:
    times: ${ITERATIONS}
    commands:
      - stopApp
      - launchApp
      - extendedWaitUntil:
          visible:
            text: "${HOME_READY_MARKER}"
          timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
`,
    "mobile-volume"
  );
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
