import {
  openAppFromAllAppsCommands,
  relaunchDevClientCommands,
  retryableTapCommands,
  waitForHomeReadyCommands,
} from "../lib/first-run.mjs";
import {
  FIRST_LAUNCH_TIMEOUT_MS,
  HOME_READY_MARKER,
  runFlow,
} from "../lib/harness.mjs";

// The shell is a springboard, not a tab bar (apps/mobile/src/navigation.ts:
// "There is no bottom-tab navigator"). All eight blueprint apps are full-screen
// covers; Settings is opened from the vault drawer. Each destination is
// asserted on copy unique to the screen it opens, never on a launcher label
// that may remain visible on Home (issue #483, enforced by
// scripts/lint-e2e-flows.mjs).
// Covers dismiss with a native swipe-down gesture that Maestro cannot drive
// reliably, so each surface is entered from a fresh launch of the app rather
// than by navigating back — React Navigation state is not persisted, so every
// launch lands on Home. Every cover is reached through the searchable All-apps
// sheet, which is the visible launcher path. The empty-vault
// "Bring in photographs/documents" copy is an import offer, not an app
// selector.
const SURFACES = [
  // Maestro anchors a text selector to the WHOLE node text, so the marker has
  // to cover all of it: the Photos search field publishes
  // "Search photos and moments" as its accessible name and renders
  // "Search photos & moments" — a bare "Search photos" matches neither.
  {
    // An empty replica starts with the camera-roll takeover card; a populated
    // replica exposes the search control instead. Both prove the Photos cover
    // opened, while the Home screen has neither string (issue #676).
    marker: "Bring 6 camera-roll photographs.*|Search photos.*",
    openCommands: [
      // The empty-vault "Bring in photographs" CTA is an import offer, not
      // the Photos cover. Search the same visible launcher sheet used by the
      // other covers so the selector cannot accidentally enter that takeover.
      openAppFromAllAppsCommands("Photos"),
      // Photos is a lazy full-screen cover. The PR #683 Settings fix showed
      // that the source tap can complete while the destination is still on
      // React's blank fallback; wait on the destination, not the closed row.
      `- extendedWaitUntil:\n    visible: "Collections"\n    timeout: 45000`,
    ].join("\n"),
    name: "photos",
  },
  {
    marker: "Add document or folder",
    openCommands: [
      // "Bring in documents" has the same import-vs-app ambiguity as Photos;
      // selecting the named row from All apps is the real launcher contract.
      openAppFromAllAppsCommands("Docs"),
      `- extendedWaitUntil:\n    visible: "Add document or folder"\n    timeout: 20000`,
    ].join("\n"),
    name: "docs",
  },
  {
    marker: "Create event",
    openCommands: openAppFromAllAppsCommands("Agenda"),
    name: "agenda",
  },
  {
    marker: "New task title",
    openCommands: openAppFromAllAppsCommands("Tasks"),
    name: "tasks",
  },
  {
    marker: "Person name",
    openCommands: openAppFromAllAppsCommands("People"),
    name: "people",
  },
  {
    marker: "Search notes",
    openCommands: openAppFromAllAppsCommands("Notes"),
    name: "notes",
  },
  {
    marker: "Fixed-point multi-currency ledger, available offline",
    openCommands: openAppFromAllAppsCommands("Tally"),
    name: "tally",
  },
  {
    marker: "Secrets stay online-only",
    openCommands: openAppFromAllAppsCommands("Locker"),
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
  // The vault identity control changed with the #726 vault-sharing merge: its
  // accessible name is now `<vault> on <gateway>. Switch vault`. Match the
  // stable suffix rather than a gateway/vault value that varies per CI run.
  {
    marker: "APPEARANCE",
    openCommands: [
      retryableTapCommands(".*Switch vault"),
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
    const openCommands = surface.openCommands;
    await ctx.run(
      `appId: ${ctx.state.appId}
---
- launchApp:
    clearState: false
    permissions:
      all: allow
${relaunchDevClientCommands(ctx.state.platform)}${waitForHomeReadyCommands(FIRST_LAUNCH_TIMEOUT_MS, ctx.state.platform)}${openCommands}
- extendedWaitUntil:
    visible: "${surface.marker}"
    timeout: 20000
- takeScreenshot: native-${surface.name}
`,
      surface.name
    );
    ctx.note(
      `${surface.name}: destination opened, "${surface.marker}" rendered`
    );
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
