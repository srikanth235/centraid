import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { HOME_READY_MARKER, runFlow } from "../lib/harness.mjs";

const UI_IMPACT_DIR = "artifacts/e2e/ui-impact";
const HOME_FRAME = "issue-905-mobile-paired-home.png";

const BUDGET_MS = 5 * 60_000;

await runFlow("pairing-canary", async (ctx) => {
  const startedAt = Date.now();

  await ctx.configureGateway();

  await ctx.run(
    `appId: ${ctx.state.appId}
---
- assertVisible: "${HOME_READY_MARKER}"
- takeScreenshot: paired-home
`,
    "canary-home"
  );

  const screenshot = async () => {
    const frames = await readdir(ctx.state.screenshotsDir);
    const home = frames.find((frame) => frame === "paired-home.png");
    if (home === undefined)
      throw new Error("paired-home frame was not captured");
    await mkdir(UI_IMPACT_DIR, { recursive: true });
    await copyFile(
      path.join(ctx.state.screenshotsDir, home),
      path.join(UI_IMPACT_DIR, HOME_FRAME)
    );
  };
  try {
    await screenshot();
  } catch (error) {
    ctx.note(`paired-home frame not published: ${error.message}`);
  }

  const elapsedMs = Date.now() - startedAt;
  ctx.note(`prerequisites proven in ${Math.ceil(elapsedMs / 1000)}s`);
  if (elapsedMs >= BUDGET_MS) {
    return {
      pass: false,
      notes: `pairing prerequisites took ${Math.ceil(elapsedMs / 1000)}s, over the ${BUDGET_MS / 60_000}-minute canary budget`,
    };
  }
  return {
    pass: true,
    notes: "gateway mints a ticket, device is paired, Home is ready",
  };
});
