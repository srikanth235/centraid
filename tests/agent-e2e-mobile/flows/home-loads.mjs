// Smoke-check: a fresh-state launch of the Expo app renders the mandatory
// scan-first onboarding entry point. Proves the harness loop end-to-end (sim
// discovery, app-install check, ctx.run, screenshot capture, verdict.md).

import { FIRST_LAUNCH_TIMEOUT_MS, runFlow } from "../lib/harness.mjs";

await runFlow("home-loads", async (ctx) => {
  // Since #603 a cleared client cannot bypass enrollment. #643/#644 made the
  // default path scan-first (showPaste=false): the primary control is
  // "Scan the QR code" and paste lives behind the secondary link. Assert the
  // live default hierarchy, then open paste and confirm the ticket UI.
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- launchApp:
    clearState: true
- extendedWaitUntil:
    visible:
      text: "Connect your gateway."
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- assertVisible: "Scan the QR code"
- assertVisible: "Can't scan? Paste a code instead"
- tapOn: "Can't scan? Paste a code instead"
- assertVisible: "Paste the one-line ticket"
# Exact ^Connect$ — bare "Connect" also matches the h1 "Connect your gateway.".
- assertVisible:
    text: "^Connect$"
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
