// Smoke-check: a fresh-state launch of the Expo app renders the mandatory
// scan-first onboarding entry point. Proves the harness loop end-to-end (sim
// discovery, app-install check, ctx.run, screenshot capture, verdict.md).

import { waitForOnboardingConnectCommands } from "../lib/first-run.mjs";
import { FIRST_LAUNCH_TIMEOUT_MS, runFlow } from "../lib/harness.mjs";

await runFlow("home-loads", async (ctx) => {
  // Since #603 a cleared client cannot bypass enrollment. #643/#644 made the
  // default path scan-first (showPaste=false): the primary control is
  // "Scan the QR code" and paste lives behind the secondary link. Assert the
  // live default hierarchy, then open paste and confirm the ticket UI.
  // Android cold emulators may raise a Pixel Launcher ANR sheet that hides
  // the hierarchy — waitForOnboardingConnectCommands dismisses it.
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- launchApp:
    clearState: true
${waitForOnboardingConnectCommands(FIRST_LAUNCH_TIMEOUT_MS)}- assertVisible: "Scan the QR code"
- assertVisible: "Can't scan? Paste a code instead"
# Tap paste by testID — text+role still no-op'd onPress on iOS 30711575336.
- tapOn:
    id: "onboarding-paste"
    retryTapIfNoChange: true
- extendedWaitUntil:
    visible:
      text: "Paste the one-line ticket"
    timeout: 15000
- assertVisible: "PAIRING CODE"
- assertVisible:
    id: "onboarding-connect"
- takeScreenshot: scan-first-onboarding
`,
    "home-fresh"
  );

  ctx.note(
    "Fresh state rendered scan-first onboarding with paste behind the secondary control"
  );
  return {
    pass: true,
    notes:
      "scan-first onboarding renders after a fresh launch; paste path opens on demand",
  };
});
