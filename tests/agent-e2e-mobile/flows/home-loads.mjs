// Smoke-check: a fresh-state launch of the Expo app renders the mandatory
// scan-first onboarding entry point. Proves the harness loop end-to-end.

import fs from "node:fs/promises";
import path from "node:path";

import {
  openPastePathCommands,
  relaunchDevClientCommands,
  waitForOnboardingConnectCommands,
} from "../lib/first-run.mjs";
import { FIRST_LAUNCH_TIMEOUT_MS, runFlow } from "../lib/harness.mjs";

const UI_IMPACT_SCREENSHOT =
  "artifacts/e2e/ui-impact/issue-676-mobile-onboarding.png";

await runFlow("home-loads", async (ctx) => {
  const freshHomeYaml = `appId: ${ctx.state.appId}
---
- launchApp:
    clearState: true
${relaunchDevClientCommands(ctx.state.platform)}${waitForOnboardingConnectCommands(FIRST_LAUNCH_TIMEOUT_MS, ctx.state.platform)}- assertVisible: "Scan the QR code"
- assertVisible: "Can't scan? Paste a code instead"
${openPastePathCommands()}- assertVisible: "PAIRING CODE"
- assertVisible:
    id: "onboarding-connect"
- assertVisible: "Scan the QR code instead"
- takeScreenshot: scan-first-onboarding
`;

  try {
    await ctx.run(freshHomeYaml, "home-fresh");
  } catch (error) {
    // A fresh iOS simulator can lose Maestro's XCTest permission bridge before
    // the first assertion. Retry the same smoke once with a new session.
    if (ctx.state.platform !== "ios") throw error;
    ctx.note(
      "iOS fresh-launch control channel failed; retrying the same smoke"
    );
    await ctx.run(freshHomeYaml, "home-fresh-retry");
  }

  const findScreenshot = async (filename) => {
    const direct = path.join(ctx.state.screenshotsDir, filename);
    try {
      await fs.access(direct);
      return direct;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const walk = async (directory) => {
      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
      const directMatch = entries.find(
        (entry) => entry.isFile() && entry.name === filename
      );
      if (directMatch) return path.join(directory, directMatch.name);
      const nested = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => walk(path.join(directory, entry.name)))
      );
      return nested.find(Boolean) ?? null;
    };

    const fallback = await walk(path.join(ctx.state.runDir, "maestro-debug"));
    if (fallback) return fallback;
    throw new Error(
      `Maestro screenshot ${filename} was not found in ${ctx.state.runDir}`
    );
  };

  const screenshot = async (destination) => {
    const source = await findScreenshot("scan-first-onboarding.png");
    const target = path.resolve(destination);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  };
  await screenshot(UI_IMPACT_SCREENSHOT);

  ctx.note(
    "Fresh state rendered scan-first onboarding with paste behind the secondary control"
  );
  return {
    pass: true,
    notes:
      "scan-first onboarding renders after a fresh launch; paste path opens on demand",
  };
});
