import { APP_ID, runFlow } from '../lib/harness.mjs';

await runFlow('native-v0-resilience', async (ctx) => {
  await ctx.run(
    `appId: ${APP_ID}
---
- launchApp:
    clearState: false
- extendedWaitUntil:
    visible: "Photos"
    timeout: 30000
- tapOn: "Docs"
- assertVisible: "Docs"
- tapOn: "Agenda"
- assertVisible: "Agenda"
- tapOn: "Apps"
- assertVisible: "Apps"
- tapOn: "Settings"
- assertVisible: "Settings"
- tapOn: "Photos"
- takeScreenshot: native-five-tabs
`,
    'five-tabs',
  );
  await ctx.restart();
  await ctx.run(
    `appId: ${APP_ID}
---
- extendedWaitUntil:
    visible: "Photos"
    timeout: 30000
- takeScreenshot: after-force-kill
`,
    'after-force-kill',
  );
  ctx.note(
    'Five native tabs survived navigation and a process restart; complete the documented network matrix on this device.',
  );
  return { pass: true, notes: 'native five-tab shell and process-restart smoke passed' };
});
