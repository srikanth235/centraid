// Smoke-check: a fresh-state launch of the Expo app renders Home in its
// `no-gateway` state. Proves the harness loop end-to-end (sim discovery,
// app-install check, ctx.run, screenshot capture, verdict.md).

import { runFlow, APP_ID } from '../lib/harness.mjs';

await runFlow('home-loads', async (ctx) => {
  await ctx.run(
    `appId: ${APP_ID}
---
- launchApp:
    clearState: true
- extendedWaitUntil:
    visible:
      text: "Connect your desktop"
    timeout: 30000
- takeScreenshot: home-fresh
- assertVisible: "Everything you build, in one place."
- assertVisible: "Connect your desktop"
- assertVisible: "Pair desktop"
`,
    'home-fresh',
  );

  ctx.note('Home rendered no-gateway state after clearState launch');
  return { pass: true, notes: 'no-gateway Home renders within 30s of fresh launch' };
});
