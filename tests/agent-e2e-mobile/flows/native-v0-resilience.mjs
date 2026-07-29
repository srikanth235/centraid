import { FIRST_LAUNCH_TIMEOUT_MS, runFlow } from "../lib/harness.mjs";

await runFlow("native-v0-resilience", async (ctx) => {
  await ctx.configureGateway();
  // Exercise every bundled blueprint through its native launcher tile. Each
  // destination is asserted with a control/copy marker unique to that screen,
  // then the common app-exit key returns to the springboard.
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- launchApp:
    clearState: false
- extendedWaitUntil:
    visible: "Everything you build, in one place."
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- tapOn: "Open Photos"
- extendedWaitUntil:
    visible: "Search photos"
    timeout: 15000
- tapOn: "Back to your apps"
- tapOn: "Open Docs"
- extendedWaitUntil:
    visible: "Add document or folder"
    timeout: 15000
- tapOn: "Back to your apps"
- tapOn: "Open Agenda"
- extendedWaitUntil:
    visible: "Create event"
    timeout: 15000
- tapOn: "Back to your apps"
- tapOn: "Open Tasks"
- extendedWaitUntil:
    visible: "New task title"
    timeout: 15000
- tapOn: "Back to your apps"
- tapOn: "Open People"
- extendedWaitUntil:
    visible: "Person name"
    timeout: 15000
- tapOn: "Back to your apps"
- tapOn: "Open Notes"
- extendedWaitUntil:
    visible: "Search notes"
    timeout: 15000
- tapOn: "Back to your apps"
- tapOn: "Open Tally"
- extendedWaitUntil:
    visible: "Fixed-point multi-currency ledger, available offline"
    timeout: 15000
- tapOn: "Back to your apps"
- tapOn: "Open Locker"
- extendedWaitUntil:
    visible: "Secrets stay online-only"
    timeout: 15000
- tapOn: "Back"
- assertVisible: "Everything you build, in one place."
- takeScreenshot: native-eight-blueprints
`,
    "five-tabs"
  );
  await ctx.restart();
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- extendedWaitUntil:
    visible: "Everything you build, in one place."
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- takeScreenshot: after-force-kill
`,
    "after-force-kill"
  );
  ctx.note(
    "All eight native blueprint covers survived navigation and a process restart; complete the documented network matrix on this device."
  );
  return {
    pass: true,
    notes: "all eight native blueprint covers and process-restart smoke passed",
  };
});
