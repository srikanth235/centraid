// Smoke-check: a fresh-state launch of the Expo app renders Home in its
// `no-gateway` state. Proves the harness loop end-to-end (sim discovery,
// app-install check, ctx.run, screenshot capture, verdict.md).

import { skipOnboarding } from '../lib/first-run.mjs';
import { FIRST_LAUNCH_TIMEOUT_MS, runFlow } from '../lib/harness.mjs';

await runFlow('home-loads', async (ctx) => {
  // Wait on the "YOUR APPS" rail label, not the pairing card: the launcher rail
  // (Home.tsx) is painted immediately, whereas the pairing card only appears
  // once the gateway probe has resolved to `no-gateway`. Waiting on the card
  // conflates "did Home render" with "did the probe finish", and on a fresh
  // launch the card also starts below the fold — see the scroll below. The rail
  // label is the stable first-paint marker; the greeting above it
  // ("Good <morning|afternoon|evening>, …") is time-of-day dependent, so
  // asserting it would make the flow fail by the clock.
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- launchApp:
    clearState: true
${skipOnboarding(ctx.state.platform, FIRST_LAUNCH_TIMEOUT_MS)}- extendedWaitUntil:
    visible:
      text: "YOUR APPS"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- takeScreenshot: home-fresh
- assertVisible: "YOUR APPS"
`,
    'home-fresh',
  );

  // Attention-line pairing banner (AttentionLine.tsx BannerCard). The Pressable
  // collapses its children into one accessibilityLabel
  // `"Connect your computer. Pair desktop"`, so matching the bare title text
  // fails on iOS even when the card is on screen (CI run 30262656256).
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- assertVisible: "Connect your computer. Pair desktop"
- takeScreenshot: home-fresh-pairing
`,
    'home-fresh-pairing',
  );

  ctx.note('Home rendered no-gateway state after clearState launch');
  return { pass: true, notes: 'no-gateway Home renders within 30s of fresh launch' };
});
