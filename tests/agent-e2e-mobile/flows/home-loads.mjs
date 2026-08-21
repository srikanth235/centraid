// Smoke-check: a fresh-state launch of the Expo app renders the mandatory
// ticket-only onboarding entry point. Proves the harness loop end-to-end (sim
// discovery, app-install check, ctx.run, screenshot capture, verdict.md).

import fs from "node:fs/promises";
import path from "node:path";

import { FIRST_LAUNCH_TIMEOUT_MS, runFlow } from "../lib/harness.mjs";

const UI_IMPACT_SCREENSHOT =
  "artifacts/e2e/ui-impact/issue-676-mobile-onboarding.png";

await runFlow("home-loads", async (ctx) => {
  // Since #603 a cleared client cannot bypass enrollment: the gateway founds
  // itself and every phone enters through a one-time pairing ticket. Assert the
  // durable field/action labels instead of obsolete Home/no-gateway copy.
  const freshHomeYaml = `appId: ${ctx.state.appId}
---
- launchApp:
    clearState: true
- extendedWaitUntil:
    visible:
      text: "Connect your gateway."
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- assertVisible: "Can't scan? Paste a code instead"
- tapOn: "Can't scan? Paste a code instead"
- assertVisible: "Paste the one-line ticket"
- assertVisible: "Connect"
- takeScreenshot: ticket-only-onboarding
`;
  try {
    await ctx.run(freshHomeYaml, "home-fresh");
  } catch (error) {
    // A fresh iOS simulator can lose Maestro's XCTest permission bridge before
    // the first assertion (30847197133). Retry the same flow once with a new
    // Maestro session; Android keeps the original single-attempt behavior.
    if (ctx.state.platform !== "ios") throw error;
    ctx.note(
      "iOS fresh-launch control channel failed; retrying the same smoke"
    );
    await ctx.run(freshHomeYaml, "home-fresh-retry");
  }

  ctx.note("Fresh state rendered the mandatory ticket-only onboarding entry");

  // Promote the safe, ticket-free Maestro capture into the standard UI-impact
  // artifact root. The matrix runner uploads `artifacts/` from every suite, so
  // this remains available even when the nightly report is assembled later.
  const findScreenshot = async (filename) => {
    const direct = path.join(ctx.state.screenshotsDir, filename);
    try {
      await fs.access(direct);
      return direct;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    // Android Maestro puts `takeScreenshot` output below --debug-output while
    // iOS also mirrors it into the flow cwd. Keep the evidence contract
    // platform-neutral by accepting either location.
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
    const source = await findScreenshot("ticket-only-onboarding.png");
    const target = path.resolve(destination);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  };
  await screenshot(UI_IMPACT_SCREENSHOT);

  return {
    pass: true,
    notes: "ticket-only onboarding renders after a fresh launch",
  };
});
