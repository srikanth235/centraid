import path from "node:path";

import { recordQualityResult } from "../../agent-e2e-shared/harness.mjs";
import { HOME_READY_MARKER, runFlow } from "../lib/harness.mjs";

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
  // Same reason as cold-start.mjs: a staged reuse launch would otherwise run
  // inside the wall clock below, adding a launch the 20-relaunch budget never
  // measured.
  await ctx.flush();
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
          timeout: 30000
`,
    "mobile-volume"
  );
  const durationMs = performance.now() - started;
  // Published, not gated: 20 relaunches on a shared CI simulator is a
  // distribution, and the paired candidate/PR run (#927) is what compares two
  // trees. This flow fails on its assertions, never on a wall clock.
  const passed = true;
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
