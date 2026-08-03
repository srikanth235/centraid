// Smoke-check: a fresh-state launch of the Expo app renders the mandatory
// scan-first onboarding entry point. Proves the harness loop end-to-end (sim
// discovery, app-install check, ctx.run, screenshot capture, verdict.md).

import {
  openPastePathCommands,
  waitForOnboardingConnectCommands,
} from "../lib/first-run.mjs";
import { FIRST_LAUNCH_TIMEOUT_MS, runFlow } from "../lib/harness.mjs";

await runFlow("home-loads", async (ctx) => {
  // Since #603 a cleared client cannot bypass enrollment. #643/#644 made the
  // default path scan-first (showPaste=false): the primary control is
  // "Scan the QR code" and paste lives behind the secondary link. Assert the
  // live default hierarchy, then open paste and confirm the ticket UI.
  // Android cold emulators may raise a Pixel Launcher ANR sheet that hides
  // the hierarchy — waitForOnboardingConnectCommands dismisses it.
  const freshHomeYaml = `appId: ${ctx.state.appId}
---
- launchApp:
    clearState: true
${waitForOnboardingConnectCommands(FIRST_LAUNCH_TIMEOUT_MS)}- assertVisible: "Scan the QR code"
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
    // the first assertion (30847197133). Retry the same flow once with a new
    // Maestro session; Android keeps the original single-attempt behavior.
    if (ctx.state.platform !== "ios") throw error;
    ctx.note(
      "iOS fresh-launch control channel failed; retrying the same smoke"
    );
    await ctx.run(freshHomeYaml, "home-fresh-retry");
  }

  ctx.note(
    "Fresh state rendered scan-first onboarding with paste behind the secondary control"
  );
  return {
    pass: true,
    notes:
      "scan-first onboarding renders after a fresh launch; paste path opens on demand",
  };
});
