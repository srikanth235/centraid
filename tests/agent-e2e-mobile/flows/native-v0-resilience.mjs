import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import {
  DISMISS_KEYBOARD_ONBOARDING,
  retryableTapCommands,
} from "../lib/first-run.mjs";
import {
  FIRST_LAUNCH_TIMEOUT_MS,
  HOME_READY_MARKER,
  runFlow,
} from "../lib/harness.mjs";

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
  // "Search photos and moments" as its accessible name and renders
  // "Search photos & moments" — a bare "Search photos" matches neither.
  {
    marker: "Search photos.*",
    open: "Open Photos.*",
    name: "photos",
  },
  {
    marker: "Add document or folder",
    open: "Open Docs.*",
    name: "docs",
  },
  { marker: "Create event", open: "Open Agenda.*", name: "agenda" },
  {
    marker: "New task title",
    open: "Open Tasks.*",
    name: "tasks",
  },
  {
    marker: "Person name",
    open: "Open People.*",
    name: "people",
  },
  {
    marker: "Search notes",
    open: "Open Notes.*",
    name: "notes",
  },
  {
    marker: "Fixed-point multi-currency ledger, available offline",
    open: "Open Tally.*",
    name: "tally",
  },
  {
    marker: "Secrets stay online-only",
    open: "Open Locker.*",
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
      retryableTapCommands("Open vault menu"),
      // Wait for the drawer to finish opening before touching its rows.
      '- extendedWaitUntil:\n    visible: "GO TO"\n    timeout: 15000',
      // The row's accessible name is ", Settings" (icon + label collapsed into
      // one element), but Maestro will not match a selector that starts with
      // the comma — `.*Settings` is what actually resolves, and with the modal
      // drawer open the dock underneath is not reachable anyway.
      retryableTapCommands(".*Settings", "GO TO"),
    ].join("\n"),
    name: "settings",
  },
];

await runFlow("native-v0-resilience", async (ctx) => {
  await ctx.configureGateway();

  const visitNext = async (index) => {
    const surface = SURFACES[index];
    if (surface === undefined) return;
    const openCommands =
      surface.openCommands ?? retryableTapCommands(surface.open);
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

  // Maestro's real airplane-mode control is Android-only. This is the device
  // journey for #738: the write goes through the mounted UI, the OS process is
  // killed while disconnected, and the production reader must recover the
  // SQLite outbox row after relaunch. The iOS lane retains the same store/read
  // integration companion because iOS Simulator exposes no airplane control.
  if (ctx.state.platform === "android") {
    const airplaneGroup = `Airplane group ${ctx.state.runId}`;
    const airplaneExpense = `Airplane expense ${ctx.state.runId}`;
    try {
      await ctx.run(
        `appId: ${ctx.state.appId}
---
- stopApp
- launchApp:
    clearState: false
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
${retryableTapCommands("Open Tally.*")}
- extendedWaitUntil:
    visible: "New group"
    timeout: 20000
- tapOn: "New group"
- inputText: "${airplaneGroup}"
${DISMISS_KEYBOARD_ONBOARDING}
- pressKey: Enter
- hideKeyboard
- extendedWaitUntil:
    visible: "${airplaneGroup}"
    timeout: 30000
- setAirplaneMode: enabled
- tapOn: "Expense description"
- inputText: "${airplaneExpense}"
- tapOn: "0.00"
- inputText: "12.34"
- assertVisible: "12.34"
- hideKeyboard
- tapOn: "Save expense"
- extendedWaitUntil:
    visible: "${airplaneExpense}"
    timeout: 20000
- assertVisible: "queued"
- takeScreenshot: native-airplane-pending-before-restart
- stopApp
- launchApp:
    clearState: false
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
${retryableTapCommands("Open Tally.*")}
- extendedWaitUntil:
    visible: "${airplaneExpense}"
    timeout: 30000
- assertVisible: "queued"
- takeScreenshot: native-airplane-pending-after-restart
`,
        "airplane-pending-restart"
      );
      ctx.note(
        "Android: Tally UI add remained queued and visible after an OS process restart in airplane mode"
      );
    } finally {
      await ctx.run(
        `appId: ${ctx.state.appId}
---
- setAirplaneMode: disabled
`,
        "restore-network"
      );
    }
  } else {
    ctx.note(
      "iOS Simulator has no Maestro airplane control; native SQLite restart parity is covered by PendingRestartJourney.test.tsx"
    );
  }

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
    "All eight native blueprint covers and Settings survived navigation and a process restart; Android also completed the airplane-mode pending-write restart journey."
  );

  // UI-impact evidence for #799: with the WebView app cover retired, Home's
  // launcher is the all-native surface — publish the post-restart Home frame
  // where the desktop journeys publish theirs.
  const uiImpactDir = "artifacts/e2e/ui-impact";
  const screenshot = async () => {
    const frames = await readdir(ctx.state.screenshotsDir);
    const home = frames.find((frame) =>
      frame.endsWith("-after-force-kill.png")
    );
    if (home === undefined)
      throw new Error("after-force-kill Home frame was not captured");
    await mkdir(uiImpactDir, { recursive: true });
    await copyFile(
      path.join(ctx.state.screenshotsDir, home),
      path.join(uiImpactDir, "issue-799-mobile-native-home.png")
    );
  };
  await screenshot();
  return {
    pass: true,
    notes:
      "all eight native blueprint covers, Settings, and process-restart smoke passed",
  };
});
