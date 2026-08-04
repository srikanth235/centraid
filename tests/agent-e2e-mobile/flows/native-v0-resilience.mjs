import {
  FIRST_LAUNCH_TIMEOUT_MS,
  HOME_READY_MARKER,
  runFlow,
} from "../lib/harness.mjs";

/**
 * One launcher-tile tap. retryableTapCommands re-taps while the tile stays in
 * the hierarchy under the cover (iOS 30748673657: Open Tally opened, then the
 * second/third retry failed looking for Open Tally on the Tally screen).
 */
function openLauncherTileCommands(open) {
  return `- tapOn:
    text: "${open}"
    retryTapIfNoChange: true`;
}

/**
 * One destination-aware fallback for the iOS tile tap. The Tasks tile stayed
 * on Home in run 30838452759 even though Maestro reported the tap completed;
 * wait for the cover transition before retrying so a successful first tap is
 * never duplicated underneath a presented cover.
 */
function retryLauncherTileCommands(open, destination) {
  return `- tapOn:
    text: "${open}"
    retryTapIfNoChange: true
- waitForAnimationToEnd:
    timeout: 3000
- extendedWaitUntil:
    visible: "${destination}"
    timeout: 5000
    optional: true
- repeat:
    times: 2
    while:
      notVisible: "${destination}"
    commands:
      - runFlow:
          when:
            visible: "${open}"
          commands:
            - tapOn:
                text: "${open}"
                retryTapIfNoChange: true
      - waitForAnimationToEnd:
          timeout: 3000`;
}

/**
 * Retry a tap only while its destination is absent. The generic retry helper
 * watches the source control, which remains in iOS's underlying Home hierarchy
 * after a modal drawer/cover opens and can therefore tap the old coordinate a
 * second time (run 30834561267).
 */
function tapUntilVisibleCommands(selector, destination) {
  return `- tapOn:
    text: "${selector}"
    retryTapIfNoChange: true
- repeat:
    times: 2
    while:
      notVisible: "${destination}"
    commands:
      - tapOn:
          text: "${selector}"
          retryTapIfNoChange: true`;
}

/**
 * Open a row whose source disappears with the drawer. Once the route is
 * requested, retrying the source can only search a closed modal; wait for the
 * destination instead (iOS lazy Settings import can show the blank fallback
 * while the screen module evaluates).
 */
function openSettingsCommands() {
  return `- tapOn:
    text: ".*Settings"
    retryTapIfNoChange: true`;
}

// The shell is a springboard, not a tab bar (apps/mobile/src/navigation.ts:
// "There is no bottom-tab navigator"). All eight blueprint apps are full-screen
// covers opened from Home's launcher tiles; Settings is opened from the vault
// drawer. Each destination is asserted on copy unique to the screen it opens,
// never on the tile label that remains visible on Home (issue #483, enforced
// by scripts/lint-e2e-flows.mjs).
// Covers dismiss with a native swipe-down gesture that Maestro cannot drive
// reliably, so each surface is entered from a fresh launch of the app rather
// than by navigating back — React Navigation state is not persisted, so every
// launch lands on Home.
const SURFACES = [
  // Maestro anchors a text selector to the WHOLE node text, so the marker has
  // to cover all of it: the Photos search field publishes
  // "Search photos and moments" as its accessible name (visible copy uses &).
  // Exact match — Search photos.* failed on a blank Photos cover after open
  // (iOS 30745625780); prefer the durable a11y label and a longer first paint.
  {
    marker: "Search photos and moments",
    open: "Open Photos",
    name: "photos",
    markerTimeoutMs: 45_000,
  },
  {
    marker: "Add document or folder",
    open: "Open Docs",
    name: "docs",
  },
  { marker: "Create event", open: "Open Agenda", name: "agenda" },
  {
    // The task TextInput's accessibility label was absent in the failed iOS
    // hierarchy even though the cover had been requested. The stable subtitle
    // proves the Tasks cover rendered without relying on input-field exposure.
    marker: "Inbox, projects and offline repeat rules",
    openCommands: retryLauncherTileCommands(
      "Open Tasks",
      "Inbox, projects and offline repeat rules"
    ),
    name: "tasks",
  },
  {
    marker: "Person name",
    open: "Open People",
    name: "people",
  },
  {
    marker: "Search notes",
    open: "Open Notes",
    name: "notes",
  },
  {
    marker: "Fixed-point multi-currency ledger, available offline",
    open: "Open Tally",
    name: "tally",
  },
  {
    marker: "Secrets stay online-only",
    open: "Open Locker",
    name: "locker",
  },
  // Settings is opened from the Vault drawer, not the dock. The dock sits at
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
    openCommands: [
      tapUntilVisibleCommands("Open vault menu", "GO TO"),
      // Wait for the drawer to finish opening before touching its rows.
      '- extendedWaitUntil:\n    visible: "GO TO"\n    timeout: 15000',
      // The row's accessible name is ", Settings" (icon + label collapsed into
      // one element), but Maestro will not match a selector that starts with
      // the comma — `.*Settings` is what actually resolves, and with the modal
      // drawer open the dock underneath is not reachable anyway.
      openSettingsCommands(),
    ].join("\n"),
    name: "settings",
    markerTimeoutMs: 45_000,
  },
];

await runFlow("native-v0-resilience", async (ctx) => {
  await ctx.configureGateway();

  const visitNext = async (index) => {
    const surface = SURFACES[index];
    if (surface === undefined) return;
    const openCommands =
      surface.openCommands ?? openLauncherTileCommands(surface.open);
    const markerTimeoutMs = surface.markerTimeoutMs ?? 20_000;
    await ctx.run(
      `appId: ${ctx.state.appId}
---
- stopApp
- launchApp:
    clearState: false
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
${openCommands}
- waitForAnimationToEnd:
    timeout: 3000
- extendedWaitUntil:
    visible: "${surface.marker}"
    timeout: ${markerTimeoutMs}
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
    visible: "${HOME_READY_MARKER}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- takeScreenshot: after-force-kill
`,
    "after-force-kill"
  );
  ctx.note(
    "All eight native blueprint covers and Settings survived navigation and a process restart; complete the documented network matrix on this device."
  );
  return {
    pass: true,
    notes:
      "all eight native blueprint covers, Settings, and process-restart smoke passed",
  };
});
