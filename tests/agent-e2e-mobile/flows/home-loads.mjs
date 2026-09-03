import {
  DEV_LAUNCHER_HANDOFF,
  FIRST_LAUNCH_TIMEOUT_MS,
  runFlow,
} from "../lib/harness.mjs";

await runFlow("home-loads", async (ctx) => {
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- launchApp:
    clearState: true
# DEV_LAUNCHER_HANDOFF is the dev client's bundle-URL handoff and is EMPTY on the
# release artifact every scheduled lane drives (#890 W1) — see lib/harness.mjs.
${DEV_LAUNCHER_HANDOFF}- extendedWaitUntil:
    visible:
      text: "Connect your gateway."
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
# The door to the ticket field, and the field and action behind it, each by its
# handle — the copy is asserted BESIDE the handle rather than instead of it,
# because these three strings are what a member on a phone with no vault
# actually reads, and a handle on a re-worded control would hide that loss.
- assertVisible:
    id: "onboarding-paste"
- assertVisible: "Can't scan? Paste a code instead"
- tapOn:
    id: "onboarding-paste"
- assertVisible:
    id: "onboarding-ticket-field"
- assertVisible: "Paste the one-line ticket"
- assertVisible:
    id: "onboarding-connect"
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
