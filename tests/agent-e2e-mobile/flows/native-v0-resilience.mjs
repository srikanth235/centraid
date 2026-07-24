import { FIRST_LAUNCH_TIMEOUT_MS, runFlow } from '../lib/harness.mjs';

await runFlow('native-v0-resilience', async (ctx) => {
  await ctx.configureGateway();
  // The five tabs are Home, Photos, Docs, Agenda, Settings — there is no "Apps"
  // tab, and the old `tapOn: "Apps"` / `assertVisible: "Apps"` pair asserted on a
  // label that exists nowhere in the app. Each tab is checked by a string unique
  // to the SCREEN it opens, not the tab label: the label is in the tab bar on
  // every screen, so `tapOn: "Docs.*"` + `assertVisible: "Docs"` passed even when
  // the tap did nothing (issue #483, enforced by scripts/lint-e2e-flows.mjs).
  //
  // Each per-tab marker is an accessibilityLabel the target screen's own header
  // publishes — the persistent action button that only that screen renders:
  //   Photos  → "Search photos"          (apps/mobile/src/apps/photos/PhotosHome.tsx)
  //   Docs    → "Add document or folder"  (apps/mobile/src/apps/docs/DocsHome.tsx)
  //   Agenda  → "Create event"            (apps/mobile/src/apps/agenda/AgendaHome.tsx)
  //   Settings→ "Desktop link"            (visible heading, Settings-unique)
  // These are Pressable accessibilityLabels — surfaced to the iOS a11y tree and
  // Maestro-matchable, the same construct template-gate keys on with "Open <name>".
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- launchApp:
    clearState: false
- extendedWaitUntil:
    visible: "Everything you build, in one place."
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- tapOn:
    text: "Photos.*"
- extendedWaitUntil:
    visible: "Search photos"
    timeout: 15000
- tapOn:
    text: "Docs.*"
- extendedWaitUntil:
    visible: "Add document or folder"
    timeout: 15000
- tapOn:
    text: "Agenda.*"
- extendedWaitUntil:
    visible: "Create event"
    timeout: 15000
- tapOn:
    text: "Settings.*"
- extendedWaitUntil:
    visible: "Desktop link"
    timeout: 15000
- tapOn:
    text: "Home.*"
- assertVisible: "Everything you build, in one place."
- takeScreenshot: native-five-tabs
`,
    'five-tabs',
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
    'after-force-kill',
  );
  ctx.note(
    'Five native tabs survived navigation and a process restart; complete the documented network matrix on this device.',
  );
  return { pass: true, notes: 'native five-tab shell and process-restart smoke passed' };
});
