import path from "node:path";

import {
  qualityRegressionBudget,
  recordQualityResult,
} from "../../agent-e2e-shared/harness.mjs";
import { HOME_READY_MARKER, runFlow } from "../lib/harness.mjs";

const OWNER = "tests/agent-e2e-mobile/flows/volume-proof.mjs";
const ITERATIONS = 20;
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

await runFlow("mobile-volume-proof", async (ctx) => {
  await ctx.configureGateway();
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
