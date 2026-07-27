import { HOME_RAIL_LABEL } from '../lib/first-run.mjs';
import { FIRST_LAUNCH_TIMEOUT_MS, runFlow } from '../lib/harness.mjs';

await runFlow('native-v0-resilience', async (ctx) => {
  await ctx.configureGateway();
  // Springboard model (issue #498): there is no bottom tab bar. Native apps are
  // full-screen covers opened from the launcher grid ("Open Photos|Docs|Agenda"
  // accessibilityLabels on LauncherGrid tiles). Settings is the glass-dock slot.
  // Each cover is checked by a string unique to THAT screen's header action,
  // not the tile name (which remains on Home under the cover):
  //   Photos  → "Search photos and moments" (PhotosHome.tsx)
  //   Docs    → "Add document or folder"    (DocsHome.tsx)
  //   Agenda  → "Create event"              (AgendaHome.tsx)
  //   Settings→ "Desktop link"              (Settings.tsx section eyebrow)
  // Covers dismiss via HomeKey ("Back to your apps"); Settings uses "Back to home".
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- launchApp:
    clearState: false
- extendedWaitUntil:
    visible: "${HOME_RAIL_LABEL}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- scrollUntilVisible:
    element:
      text: "Open Photos"
    direction: DOWN
- tapOn:
    text: "Open Photos"
- extendedWaitUntil:
    visible: "Search photos and moments"
    timeout: 15000
- tapOn: "Back to your apps"
- extendedWaitUntil:
    visible: "${HOME_RAIL_LABEL}"
    timeout: 15000
- scrollUntilVisible:
    element:
      text: "Open Docs"
    direction: DOWN
- tapOn:
    text: "Open Docs"
- extendedWaitUntil:
    visible: "Add document or folder"
    timeout: 15000
- tapOn: "Back to your apps"
- extendedWaitUntil:
    visible: "${HOME_RAIL_LABEL}"
    timeout: 15000
- scrollUntilVisible:
    element:
      text: "Open Agenda"
    direction: DOWN
- tapOn:
    text: "Open Agenda"
- extendedWaitUntil:
    visible: "Create event"
    timeout: 15000
- tapOn: "Back to your apps"
- extendedWaitUntil:
    visible: "${HOME_RAIL_LABEL}"
    timeout: 15000
- tapOn: "Settings"
- extendedWaitUntil:
    visible: "Desktop link"
    timeout: 15000
- tapOn: "Back to home"
- extendedWaitUntil:
    visible: "${HOME_RAIL_LABEL}"
    timeout: 15000
- takeScreenshot: native-covers
`,
    'native-covers',
  );
  await ctx.restart();
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- extendedWaitUntil:
    visible: "${HOME_RAIL_LABEL}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- takeScreenshot: after-force-kill
`,
    'after-force-kill',
  );
  ctx.note(
    'Native Photos/Docs/Agenda covers + Settings survived navigation and a process restart.',
  );
  return {
    pass: true,
    notes: 'springboard native covers and process-restart smoke passed',
  };
});
