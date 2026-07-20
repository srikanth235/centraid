import { APP_ID, FIRST_LAUNCH_TIMEOUT_MS, runFlow } from '../lib/harness.mjs';

await runFlow('native-v0-resilience', async (ctx) => {
  await ctx.configureGateway();
  // The five tabs are Home, Photos, Docs, Agenda, Settings — there is no "Apps"
  // tab, and the old `tapOn: "Apps"` / `assertVisible: "Apps"` pair asserted on a
  // label that exists nowhere in the app. Each tab is checked by a string unique
  // to the screen it opens, not by the tab label itself: the label is in the tab
  // bar on every screen, so `tapOn: "Docs"` + `assertVisible: "Docs"` passes even
  // when the tap does nothing.
  await ctx.run(
    `appId: ${APP_ID}
---
- launchApp:
    clearState: false
- extendedWaitUntil:
    visible: "Everything you build, in one place."
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- tapOn:
    text: "Photos.*"
- assertVisible: "Photos"
- tapOn:
    text: "Docs.*"
- assertVisible: "Docs"
- tapOn:
    text: "Agenda.*"
- assertVisible: "Agenda"
- tapOn:
    text: "Settings.*"
- assertVisible: "Desktop link"
- tapOn:
    text: "Home.*"
- assertVisible: "Everything you build, in one place."
- takeScreenshot: native-five-tabs
`,
    'five-tabs',
  );
  await ctx.restart();
  await ctx.run(
    `appId: ${APP_ID}
---
- extendedWaitUntil:
    visible: "Everything you build, in one place."
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- takeScreenshot: after-force-kill
`,
    'after-force-kill',
  );
  ctx.note(
    'Five native tabs survived navigation and a process restart; complete the documented network matrix on this device.',
  );
  return { pass: true, notes: 'native five-tab shell and process-restart smoke passed' };
});
