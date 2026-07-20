// Smoke-check: a fresh-state launch of the Expo app renders Home in its
// `no-gateway` state. Proves the harness loop end-to-end (sim discovery,
// app-install check, ctx.run, screenshot capture, verdict.md).

import { runFlow, APP_ID, FIRST_LAUNCH_TIMEOUT_MS } from '../lib/harness.mjs';

await runFlow('home-loads', async (ctx) => {
  // Wait on the hero, not the pairing card: the hero is the first thing Home
  // paints, whereas the pairing card only appears once the gateway probe has
  // resolved to `no-gateway`. Waiting on the card conflates "did Home render"
  // with "did the probe finish" and, on a fresh launch, the card also starts
  // below the fold — see the scroll below.
  await ctx.run(
    `appId: ${APP_ID}
---
- launchApp:
    clearState: true
- extendedWaitUntil:
    visible:
      text: "Everything you build, in one place."
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- takeScreenshot: home-fresh
- assertVisible: "Everything you build, in one place."
- assertVisible: "Built in"
`,
    'home-fresh',
  );

  // The "Your apps" section sits below the fold on a phone-sized screen, and on
  // a fresh install it must offer pairing. Scroll it into view rather than
  // asserting on the off-screen node: Maestro will happily match an element
  // hidden behind the tab bar, which is how the old flow "passed" while the
  // pairing button was in fact untappable.
  await ctx.run(
    `appId: ${APP_ID}
---
- scrollUntilVisible:
    element:
      text: "Connect your desktop"
    direction: DOWN
    visibilityPercentage: 100
- assertVisible: "Connect your desktop"
- assertVisible: "Pair desktop"
- takeScreenshot: home-fresh-pairing
`,
    'home-fresh-pairing',
  );

  ctx.note('Home rendered no-gateway state after clearState launch');
  return { pass: true, notes: 'no-gateway Home renders within 30s of fresh launch' };
});
