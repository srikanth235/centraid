// Smoke-check: a fresh-state launch of the Expo app renders the mandatory
// ticket-only onboarding entry point. Proves the harness loop end-to-end (sim
// discovery, app-install check, ctx.run, screenshot capture, verdict.md).

import { FIRST_LAUNCH_TIMEOUT_MS, runFlow } from "../lib/harness.mjs";

await runFlow("home-loads", async (ctx) => {
  // Since #603 a cleared client cannot bypass enrollment: the gateway founds
  // itself and every phone enters through a one-time pairing ticket. Assert the
  // durable field/action labels instead of obsolete Home/no-gateway copy.
  await ctx.run(
    `appId: ${ctx.state.appId}
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
`,
    "home-fresh"
  );

  ctx.note("Fresh state rendered the mandatory ticket-only onboarding entry");
  return {
    pass: true,
    notes: "ticket-only onboarding renders after a fresh launch",
  };
});
