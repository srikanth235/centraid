import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import {
  DISMISS_KEYBOARD_ONBOARDING,
  LAUNCHER_RECOVERY,
  retryableTapCommands,
} from "../lib/first-run.mjs";
import {
  HOME_READY_MARKER,
  RELAUNCH_TIMEOUT_MS,
  runFlow,
} from "../lib/harness.mjs";

// ─── The strings the rebuilt Tally cover actually publishes ─────────────────
//
// Every one of these is a §6 sentence from `packages/blueprints/apps/tally`,
// spelled here with `.` where the product uses a middle dot: Maestro reads a
// text selector as a regex anchored to the WHOLE node text, and `·` is not a
// character it matches reliably. Same convention as `tally-derived.mjs`.

/** `view-copy.ts` BALANCES_STATUS — the app bar's line on the Balances place. */
const BALANCES_STATUS =
  "Every figure is derived at read time . no balance is stored and none is transmitted";
/** `view-copy.ts` ROUTE_STATUS.groups. */
const GROUPS_STATUS =
  "A group is a shared circle . members co-contribute from their own vaults";
/** `view-copy.ts` GROUP_HERO_SUB — drawn by one group's ledger and nowhere else. */
const GROUP_HERO_SUB =
  "Every member computes this figure themselves, from the same facts.";
/** `view-copy.ts` ROUTE_STATUS.add — the composer's own ambient sentence. */
const ADD_STATUS =
  "Six ways to divide it . the method is recorded with the shares";
/** `view-copy.ts` ROUTE_STATUS.contrib — Waiting's own sentence. */
const WAITING_STATUS =
  "Every contribution says whose it is, where it is, and what it is waiting on";
/** `tally-seat-copy.ts` WAITING_OWN_SCOPE — whose rows this seat can account for. */
const WAITING_SCOPE = "Your own writes, from this device.*";
/** `contrib-model.ts` REASON.queued — where a queued write is, in its own words. */
const QUEUED_REASON = ".*on a device, not in the vault yet.*";
/** `compose-copy.ts` PLACEHOLDERS — the two typed fields of §3, by their
 *  placeholders, which is what an empty RN `TextInput` publishes as its text. */
const DESCRIPTION_PLACEHOLDER = "Dinner at the Ship";
const AMOUNT_PLACEHOLDER = "0.00";
/** `seed.js` — the one group the Tally demo scenario creates. */
const DEMO_GROUP = "Tahoe Trip";

// The shell is a springboard, not a tab bar (apps/mobile/src/navigation.ts:
// "There is no bottom-tab navigator"). The blueprint apps are full-screen
// covers opened from Home's launcher tiles; Settings is opened from the vault
// drawer. Each destination is asserted on copy unique to the screen it opens,
// never on the tile label that remains visible on Home (issue #483, enforced
// by scripts/lint-e2e-flows.mjs).
// Covers dismiss with a native swipe-down gesture that Maestro cannot drive
// reliably, so each surface is entered from a fresh launch of the app rather
// than by navigating back — React Navigation state is not persisted, so every
// launch lands on Home.
//
// EVERY MARKER BELOW IS TRACED TO THE STRING THE COVER ACTUALLY PUBLISHES, and
// each one is the arrival marker its own app's journey already uses, so the two
// cannot disagree about what "the cover opened" means. The v17 rebuilds moved
// several of them: the pre-rebuild list keyed on `Search photos`,
// `Add document or folder`, `Create event`, `New task title`, `Person name`,
// `Search notes`, a Tally subtitle and a Locker subtitle — of which only the
// Notes one still existed anywhere, and that one on the WEB seat's frame rather
// than on this cover. A marker that matches nothing is a step that is red for a
// reason unrelated to its claim, which is the other half of what issue #483 is
// about.
const SURFACES = [
  // The Photos band's second destination (`photos-band.ts`), which every Photos
  // surface draws and Home draws none of. `photos-library.mjs`'s own arrival
  // marker. The pre-rebuild `Search photos.*` keyed on the search field's
  // placeholder, now "Search photographs, people, places, albums" — and that
  // field lives on the Search destination, not on the one a cover opens to.
  { marker: "Collections", open: "Open Photos.*", name: "photos" },
  // The All shelf's own foot sentence (`apps/docs/docs-copy.ts` allStatus), and
  // `docs-drive.mjs`'s arrival marker. The digit is part of it: a drive read
  // that never reached the replica has a shape, and this assertion can see it.
  {
    marker: "[0-9,]+ · press and hold a row for quick actions",
    open: "Open Docs.*",
    name: "docs",
  },
  // `AgendaHome.tsx`'s header action, and `agenda-week.mjs`'s arrival marker.
  { marker: "Go to today", open: "Open Agenda.*", name: "agenda" },
  // The capture field at the foot of `TasksHome.tsx`, which is drawn on every
  // Tasks destination (`view-copy.ts` QUICK_ADD.touchPlaceholder is
  // "What is it? Name it for Friday"). The tail is taken rather than the whole
  // sentence: a `?` is neither a valid YAML double-quoted escape nor a literal
  // in a regex, and the tail is unique on its own.
  {
    marker: ".*Name it for Friday",
    open: "Open Tasks.*",
    name: "tasks",
  },
  // The People band's second destination (`people-band.ts` TOUCH_TITLE). The
  // roster itself has two honest shapes — a first run and a filled list — so a
  // marker inside the body would assert one vault's contents, not an arrival.
  { marker: "Touch", open: "Open People.*", name: "people" },
  // `NotesHome.tsx`'s own control, and `notes-library.mjs`'s arrival marker.
  { marker: "New note", open: "Open Notes.*", name: "notes" },
  // Tally and Locker were rebuilt from the v17 handoff (#872), and both covers
  // now carry the design's per-route ambient sentence in the app bar instead of
  // a fixed subtitle. These two markers are those sentences, and they are the
  // same ones `tally-derived.mjs` and `locker-gate.mjs` assert on arrival.
  { marker: BALANCES_STATUS, open: "Open Tally.*", name: "tally" },
  {
    marker: "Nothing is browsable until there is a passphrase",
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
  // it, so it proves arrival without a scroll. YouSection now sits above the
  // Appearance section (Settings.tsx), so the heading may be below the fold —
  // scroll to it instead of assuming the first viewport.
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
      '- scrollUntilVisible:\n    element:\n      text: "APPEARANCE"\n    direction: DOWN',
    ].join("\n"),
    name: "settings",
  },
];

await runFlow("native-v0-resilience", async (ctx) => {
  // The airplane journey below opens ONE GROUP'S LEDGER before it disconnects,
  // because that is the only path to the composer on a vault that is not on
  // day one, and because the group's payload has to be in memory for the
  // composer to know who the expense divides between. The Home fill below
  // seeds the phone's replica after pairing.
  await ctx.configureGateway({ fillSampleContent: true });

  const visitNext = async (index) => {
    const surface = SURFACES[index];
    if (surface === undefined) return;
    // The graded grid holds every seeded app, which on a phone is more rows
    // than one viewport — scroll the tile into view before tapping it.
    // scrollUntilVisible completes immediately when the tile is already up.
    const scrollToTile = surface.open
      ? `- scrollUntilVisible:
    element:
      text: "${surface.open}"
    direction: DOWN
`
      : "";
    const openCommands =
      surface.openCommands ?? retryableTapCommands(surface.open);
    await ctx.run(
      `appId: ${ctx.state.appId}
---
- stopApp
- launchApp:
    clearState: false
${LAUNCHER_RECOVERY}- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${RELAUNCH_TIMEOUT_MS}
${scrollToTile}${openCommands}
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
  //
  // WHAT THE REBUILT COVER CAN AND CANNOT SHOW OFFLINE, because it decides the
  // assertions here. Tally's WRITES are ordinary and queue in the durable
  // outbox; its derived READS are gateway RPCs (`tally-gateway.ts`: one balance
  // engine, and it is `queries/dashboard.ts`'s). So an offline relaunch cannot
  // draw the expense's description anywhere — the ledger it would appear in is
  // a read that never lands — and the surface that IS true offline is Waiting,
  // which folds `session.pendingChanges()` (this device's own outbox) into
  // rows. The pre-#872 flow asserted the description after the relaunch; that
  // assertion named a dashboard read, not the queued write, and the queued row
  // is what the journey is actually about.
  if (ctx.state.platform === "android") {
    const airplaneExpense = `Airplane expense ${ctx.state.runId}`;
    try {
      await ctx.run(
        `appId: ${ctx.state.appId}
---
- stopApp
- launchApp:
    clearState: false
${LAUNCHER_RECOVERY}- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${RELAUNCH_TIMEOUT_MS}
${retryableTapCommands("Open Tally.*")}
- extendedWaitUntil:
    visible: "${BALANCES_STATUS}"
    timeout: 20000
# Into one group's ledger WHILE THE GATEWAY STILL ANSWERS. The composer divides
# between the group's own members, and those arrive with the group payload; a
# member who opens the composer with no landed group has nobody to divide
# between, which is a fact about the read plane and not about this flow.
${retryableTapCommands("Groups", BALANCES_STATUS)}
- extendedWaitUntil:
    visible: "${GROUPS_STATUS}"
    timeout: 20000
${retryableTapCommands(DEMO_GROUP, GROUPS_STATUS)}
- extendedWaitUntil:
    visible: "${GROUP_HERO_SUB}"
    timeout: 20000
- setAirplaneMode: enabled
# The ledger section's own verb, on the group that is already on screen.
${retryableTapCommands("Add expense", GROUP_HERO_SUB)}
- extendedWaitUntil:
    visible: "${ADD_STATUS}"
    timeout: 20000
# The two typed fields of §3, tapped by their placeholders — everything else on
# this screen is a chip. Each typed value is asserted AT the field, which is
# where a swallowed keystroke actually happens.
- tapOn: "${DESCRIPTION_PLACEHOLDER}"
- inputText: "${airplaneExpense}"
${DISMISS_KEYBOARD_ONBOARDING}
- assertVisible: "${airplaneExpense}"
- tapOn: "${AMOUNT_PLACEHOLDER}"
- inputText: "12.34"
- assertVisible: "12.34"
- hideKeyboard
# THE FOOT NAMES WHERE THE WRITE LANDS BEFORE THE COMMIT, not after it — and
# offline that sentence is the whole promise this journey then goes and checks.
- assertVisible: "Lands in ${DEMO_GROUP} . queued on this device until the gateway answers"
- tapOn:
    text: "Add expense"
    below: "Lands in ${DEMO_GROUP}.*"
# Waiting is the band's fourth place and the one surface that reads the durable
# outbox rather than the gateway.
${retryableTapCommands("Waiting", GROUP_HERO_SUB)}
- extendedWaitUntil:
    visible: "${WAITING_STATUS}"
    timeout: 20000
- assertVisible: "QUEUED"
- assertVisible: "${QUEUED_REASON}"
- takeScreenshot: native-airplane-pending-before-restart
- stopApp
- launchApp:
    clearState: false
${LAUNCHER_RECOVERY}- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${RELAUNCH_TIMEOUT_MS}
${retryableTapCommands("Open Tally.*")}
- extendedWaitUntil:
    visible: "${BALANCES_STATUS}"
    timeout: 30000
${retryableTapCommands("Waiting", BALANCES_STATUS)}
- extendedWaitUntil:
    visible: "${WAITING_STATUS}"
    timeout: 30000
# THE CLAIM. Nothing of the previous process survived except the SQLite file,
# and the gateway is still unreachable, so the row, its status and the sentence
# that says where it is can only have come off the durable outbox.
- assertVisible: "QUEUED"
- assertVisible: "${QUEUED_REASON}"
- assertVisible: "${WAITING_SCOPE}"
- takeScreenshot: native-airplane-pending-after-restart
`,
        "airplane-pending-restart"
      );
      ctx.note(
        "Android: a Tally expense recorded through the composer in airplane mode still drew its QUEUED row in Waiting after an OS process restart"
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
      "iOS Simulator has no Maestro airplane control; the same contract is covered on iOS-compatible infrastructure by apps/mobile/src/apps/tally/PendingRestartJourney.test.tsx"
    );
  }

  await ctx.restart();
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${RELAUNCH_TIMEOUT_MS}
- takeScreenshot: after-force-kill
`,
    "after-force-kill"
  );
  ctx.note(
    "Seven native blueprint covers (Tally excised: its cover is deliberately empty pending redesign) and Settings survived navigation and a process restart; Android also completed the airplane-mode pending-write restart journey."
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
    await copyFile(
      path.join(ctx.state.screenshotsDir, home),
      path.join(uiImpactDir, "issue-676-home-ready-seed.png")
    );
  };
  await screenshot();
  return {
    pass: true,
    notes:
      "seven native blueprint covers (Tally excised: empty cover pending redesign), Settings, and process-restart smoke passed",
  };
});
