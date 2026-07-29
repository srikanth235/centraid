import { FIRST_LAUNCH_TIMEOUT_MS, runFlow } from "../lib/harness.mjs";

// The shell is a springboard, not a tab bar (apps/mobile/src/navigation.ts:
// "There is no bottom-tab navigator"). Photos, Docs and Agenda are full-screen
// covers opened from Home's launcher tiles; Settings is opened from the glass
// dock. So each surface is reached the way a user reaches it — by its tile's
// accessibility label, `Open <name>` (LauncherGrid.tsx) — and asserted on a
// string unique to the SCREEN it opens, never on the tile label, which is on
// Home whether or not the tap did anything (issue #483, enforced by
// scripts/lint-e2e-flows.mjs):
//   Photos   → "Search photos"           (apps/mobile/src/apps/photos/PhotosHome.tsx)
//   Docs     → "Add document or folder"  (apps/mobile/src/apps/docs/DocsHome.tsx)
//   Agenda   → "Create event"            (apps/mobile/src/apps/agenda/AgendaHome.tsx)
//   Settings → "APPEARANCE"             (section heading, Settings-unique)
// Covers dismiss with a native swipe-down gesture that Maestro cannot drive
// reliably, so each surface is entered from a fresh launch of the app rather
// than by navigating back — React Navigation state is not persisted, so every
// launch lands on Home.
const SURFACES = [
  // Maestro anchors a text selector to the WHOLE node text, so the marker has
  // to cover all of it: the Photos search field publishes
  // "Search photos and moments" as its accessible name and renders
  // "Search photos & moments" — a bare "Search photos" matches neither.
  {
    marker: "Search photos.*",
    open: '- tapOn: "Open Photos"',
    name: "photos",
  },
  {
    marker: "Add document or folder",
    open: '- tapOn: "Open Docs"',
    name: "docs",
  },
  { marker: "Create event", open: '- tapOn: "Open Agenda"', name: "agenda" },
  // The dock's Settings slot carries accessibilityLabel="Settings"
  // (screens/home/GlassDock.tsx).
  // Settings is opened from the Space drawer, not the dock. The dock sits at
  // the very bottom of the screen, exactly where the dev build's LogBox toast
  // ("Open debugger to view warnings.") parks itself — it reappears whenever
  // Home's data load emits a warning, so a dock tap right after launch lands on
  // the toast, reports COMPLETED, and navigates nowhere. The drawer handle is
  // top-right and never covered. Its Settings row publishes ", Settings"
  // (icon + label in one accessibility element), which the dock's plain
  // "Settings" does not match.
  //
  // "Desktop link" is three scroll pages down inside Settings; "APPEARANCE" is
  // the first section heading it publishes and nothing else in the app renders
  // it, so it proves arrival without a scroll.
  {
    marker: "APPEARANCE",
    open: [
      '- tapOn: "Open space menu"',
      // Wait for the drawer to finish opening before touching its rows.
      '- extendedWaitUntil:\n    visible: "GO TO"\n    timeout: 15000',
      // The row's accessible name is ", Settings" (icon + label collapsed into
      // one element), but Maestro will not match a selector that starts with
      // the comma — `.*Settings` is what actually resolves, and with the modal
      // drawer open the dock underneath is not reachable anyway.
      '- tapOn: ".*Settings"',
    ].join("\n"),
    name: "settings",
  },
];

await runFlow("native-v0-resilience", async (ctx) => {
  await ctx.configureGateway();

  const visitNext = async (index) => {
    const surface = SURFACES[index];
    if (surface === undefined) return;
    await ctx.run(
      `appId: ${ctx.state.appId}
---
- stopApp
- launchApp:
    clearState: false
- extendedWaitUntil:
    visible: "YOUR APPS"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
${surface.open}
- extendedWaitUntil:
    visible: "${surface.marker}"
    timeout: 20000
- takeScreenshot: native-${surface.name}
`,
      surface.name
    );
    ctx.note(`${surface.name}: opened from Home, "${surface.marker}" rendered`);
    return visitNext(index + 1);
  };
  await visitNext(0);

  await ctx.restart();
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- extendedWaitUntil:
    visible: "YOUR APPS"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- takeScreenshot: after-force-kill
`,
    "after-force-kill"
  );
  ctx.note(
    "Four native surfaces survived navigation and a process restart; complete the documented network matrix on this device."
  );
  return {
    pass: true,
    notes: "springboard covers and process-restart smoke passed",
  };
});
