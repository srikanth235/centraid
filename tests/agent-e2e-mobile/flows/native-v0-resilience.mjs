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

const TASKS_DESTINATION = "Inbox, projects and offline repeat rules";

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
    // iOS 26 has acknowledged the Tasks launcher row while leaving Home on
    // screen (the old tile path hit this in run 30838452759 and the current
    // searchable path reproduced it in run 31351935538). The subtitle is a
    // stable native-cover marker even when XCTest omits the TextInput's
    // accessibility label; the helper retries only while Home's launcher
    // source is still visible.
    marker: TASKS_DESTINATION,
    openCommands: openAppFromAllAppsCommands("Tasks", TASKS_DESTINATION),
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
  // Settings is opened from the vault switcher sheet, not the dock. The dock
  // sits at the very bottom of the screen, exactly where the dev build's LogBox
  // toast ("Open debugger to view warnings.") parks itself — it reappears
  // whenever Home's data load emits a warning, so a dock tap right after launch
  // lands on the toast, reports COMPLETED, and navigates nowhere. Current main's
  // vault-sharing UI uses a bottom-sheet `Vaults` switcher; its durable
  // `Pair another desktop` row routes to Settings and is available regardless
  // of the active vault names.
  //
  // "Desktop link" is three scroll pages down inside Settings; "APPEARANCE" is
  // the first section heading it publishes and nothing else in the app renders
  // it, so it proves arrival without a scroll.
  // The old `GO TO` drawer and its `Switch vault` header are gone on current
  // main. Match the sheet row rather than gateway/vault values that vary per CI
  // run; the final `APPEARANCE` assertion still proves Settings arrival.
  {
    marker: "APPEARANCE",
    openCommands: retryableTapCommands("Pair another desktop"),
    name: "settings",
  },
];

const requestedSurface = process.env.MAESTRO_NATIVE_SURFACE;
const surfacesToVisit = requestedSurface
  ? SURFACES.filter((surface) => surface.name === requestedSurface)
  : SURFACES;
if (requestedSurface && surfacesToVisit.length === 0) {
  throw new Error(
    `Unknown MAESTRO_NATIVE_SURFACE ${JSON.stringify(requestedSurface)}`
  );
}

await runFlow("native-v0-resilience", async (ctx) => {
  await ctx.configureGateway();

  const visitNext = async (index) => {
    const surface = surfacesToVisit[index];
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
    `${surfacesToVisit.length === SURFACES.length ? "All eight native blueprint covers and Settings" : `${surfacesToVisit.map((surface) => surface.name).join(", ")} cover`} survived navigation and a process restart; complete the documented network matrix on this device.`
  );
  return {
    pass: true,
    notes: `${surfacesToVisit.length === SURFACES.length ? "all eight native blueprint covers, Settings" : `${surfacesToVisit.map((surface) => surface.name).join(", ")} cover`} and process-restart smoke passed`,
  };
});
