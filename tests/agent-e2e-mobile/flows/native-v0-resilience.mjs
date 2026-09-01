import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import {
  DISMISS_KEYBOARD_ONBOARDING,
  retryableTapCommands,
} from "../lib/first-run.mjs";
import {
  AWAIT_LAUNCHER,
  FIRST_LAUNCH_TIMEOUT_MS,
  HOME_READY_MARKER,
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
/**
 * THE ROUTE TO TALLY, used at all four places this flow opens it.
 *
 * Not the Home grid: the tile counts expenses `spent_on >= monthStart` and says
 * "spent this month", while `seed.js` dates the demo expenses 4 and 6 days ago,
 * so for the first week of any month Tally is a FIRST MOVE ("Log a shared
 * expense") rather than "Open Tally, …" and a grid tap finds nothing. The
 * all-apps sheet lists every app unconditionally, labelled `Open <name>,
 * <count>` by `AllAppsSheet.tsx` whatever the tile status — including offline,
 * where the count degrades but the label still matches (#905).
 */
const OPEN_TALLY = `- tapOn:
    id: "home-band-more"
    retryTapIfNoChange: true
- extendedWaitUntil:
    visible:
      id: "home-all-apps"
    timeout: 15000
- scrollUntilVisible:
    element:
      text: "Open Tally.*"
    direction: DOWN
    visibilityPercentage: 100
    timeout: 20000
${retryableTapCommands("Open Tally.*")}`;

/** `seed.js` — the one group the Tally demo scenario creates. */
const DEMO_GROUP = "Tahoe Trip";

// The shell is a springboard, not a tab bar (apps/mobile/src/navigation.ts:
// "There is no bottom-tab navigator"). All eight blueprint apps are full-screen
// covers opened from Home's launcher tiles; Settings is a PLACE, reached from
// the band's More tab through the all-apps sheet (see the `settings` entry
// below for what that replaced). Each destination is asserted on copy unique to
// the screen it opens, never on the tile label that remains visible on Home
// (issue #483, enforced by scripts/lint-e2e-flows.mjs).
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
  // Tally opens through the sheet (`OPEN_TALLY` above) rather than the grid,
  // because its tile is absent for the first week of every month; the reason
  // is on that constant, and the other three relaunches share it.
  {
    marker: BALANCES_STATUS,
    name: "tally",
    openCommands: OPEN_TALLY,
  },
  {
    marker: "Nothing is browsable until there is a passphrase",
    open: "Open Locker.*",
    name: "locker",
  },
  // SETTINGS IS A PLACE NOW, AND THE PATH THIS FLOW USED IS GONE.
  //
  // Until #890 W2 this entry reached Settings through a vault drawer:
  // `Open vault menu` → wait for `GO TO` → tap `.*Settings`. NONE of those three
  // strings exists anywhere in `apps/mobile/src` any more — the v17 shell ships
  // no drawer at all. `screens/home/AllAppsSheet.tsx` says so at the handle it
  // replaced them with: "Settings is reached from HERE, not from a drawer".
  // The failure was LOUD rather than silent — `retryableTapCommands` opens with
  // a non-optional `tapOn`, and a `tapOn` whose selector matches nothing is an
  // error, not a no-op — but it was still a step red for a reason unrelated to
  // its claim, which is the other half of issue #483. DO NOT "RESTORE" THE
  // DRAWER PATH: there is nothing to restore it to.
  //
  // The route now is the band's More tab → the all-apps sheet → the Settings
  // place row, and all three carry handles (`home-band-more`, `home-all-apps`,
  // `home-place-<place id>`), so none of the hops keys on copy. Settings is the
  // LAST row of the sheet's places half, below all eight apps, so it is
  // scrolled to at full visibility rather than tapped where it is only
  // partially on screen — Maestro matches an element the sheet has clipped
  // (README "A passing step is not a working step").
  //
  // "Desktop link" is three scroll pages down inside Settings; "APPEARANCE" is
  // the first section heading it publishes and nothing else in the app renders
  // it, so it proves arrival without a scroll.
  {
    marker: "APPEARANCE",
    openCommands: `- tapOn:
    id: "home-band-more"
    retryTapIfNoChange: true
- extendedWaitUntil:
    visible:
      id: "home-all-apps"
    timeout: 15000
- scrollUntilVisible:
    element:
      id: "home-place-settings"
    direction: DOWN
    visibilityPercentage: 100
    timeout: 20000
- tapOn:
    id: "home-place-settings"
    retryTapIfNoChange: true
- extendedWaitUntil:
    visible:
      id: "settings-screen"
    timeout: 20000`,
    name: "settings",
  },
];

await runFlow("native-v0-resilience", async (ctx) => {
  // The airplane journey below opens ONE GROUP'S LEDGER before it disconnects,
  // because that is the only path to the composer on a vault that is not on
  // day one, and because the group's payload has to be in memory for the
  // composer to know who the expense divides between. Seeded before pairing so
  // the corpus arrives in the first replica clone; the GET guard makes it a
  // no-op when another flow in the suite already seeded it.
  await ctx.ensureDemo("tally");
  await ctx.configureGateway();

  // ONE MAESTRO SPAWN FOR THE WHOLE TOUR, not one per surface (#905).
  //
  // `pr-gate-budget.md` names this as the FIRST thing to do when the gate
  // overruns twelve minutes — "combine adjacent Maestro chunks … the per-spawn
  // overhead is real" — and run 33539023776 priced it: every `run :` line sits
  // about NINE SECONDS ahead of the first command in its chunk (17:53:34 →
  // 17:53:43 for `06-people`, 17:54:07 → 17:54:16 for `07-notes`, 17:54:37 →
  // 17:54:46 for `08-tally`), which is JVM start plus driver connect and buys
  // nothing. Ten surfaces paid it ten times; the tour now pays it once.
  //
  // NOTHING IS DROPPED. Every surface keeps its own `stopApp` + `launchApp` —
  // the relaunch IS the resilience claim, and combining chunks removes the
  // spawn between them, never the process death — plus its own launcher wait,
  // its own arrival marker and its own screenshot.
  //
  // What it costs: `ctx.note` per surface used to land as each one passed, so a
  // tour that died at surface eight left seven notes behind it. They are
  // emitted together after the tour now, so a failure leaves none. The evidence
  // that replaces them is Maestro's own — a failing command is printed with its
  // selector, and `takeScreenshot: native-<name>` still fires per surface, so
  // the debug directory shows exactly how far the tour walked.
  const surfaceBlock = (surface) => {
    // SCROLL THE GRID BEFORE TAPPING IT (#905). `SPRINGBOARD_ORDER` is photos,
    // docs, notes, agenda, tasks, people, tally, locker, and only the first
    // FIVE fit a Pixel 6 screen — the phone re-launches before every surface
    // below, so Home is back at the top each time and the last three tiles are
    // under the fold. `tapOn` does not scroll: it fails outright on a selector
    // that matches nothing on screen, which is how `Tap on "Open People.*"`
    // failed on run 33525449602 against a grid that was drawing People
    // perfectly well, three tiles down.
    //
    // This was never a regression — it is a step that had not been REACHED
    // since before the Tasks cover started throwing, so the tour died at
    // `05-tasks` and nothing past it ran. `scrollUntilVisible` is a no-op for a
    // tile already on screen, so the first five are unaffected, and
    // `visibilityPercentage: 100` is the same guard the Settings entry below
    // uses for the same reason: Maestro will match an element the fold has
    // clipped (README, "A passing step is not a working step").
    const openCommands =
      surface.openCommands ??
      `- scrollUntilVisible:
    element:
      text: "${surface.open}"
    direction: DOWN
    visibilityPercentage: 100
    timeout: 20000
${retryableTapCommands(surface.open)}`;
    return `- stopApp
- launchApp:
    clearState: false
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
# The launcher before every open, here and at the three Tally relaunches below:
# the band's marker renders on DayOne too, so it cannot tell a Home that has the
# seeded vault from one still waiting for it (see AWAIT_LAUNCHER).
${AWAIT_LAUNCHER}${openCommands}
- extendedWaitUntil:
    visible: "${surface.marker}"
    timeout: 20000
- takeScreenshot: native-${surface.name}
`;
  };
  await ctx.run(
    `appId: ${ctx.state.appId}
---
${SURFACES.map((surface) => surfaceBlock(surface)).join("")}`,
    "tour"
  );
  for (const surface of SURFACES) {
    ctx.note(`${surface.name}: opened from Home, "${surface.marker}" rendered`);
  }

  // Maestro's real airplane-mode control is Android-only. This is the device
  // journey for #738: the write goes through the mounted UI, the OS process is
  // killed while disconnected, the production reader must recover the SQLite
  // outbox row after relaunch, AND — since #890 W4 — the radio comes back and
  // the row has to leave the outbox on its own. The three halves are one claim:
  // OFFLINE WRITE → SURVIVES PROCESS DEATH → RECONNECTS AND SETTLES. A flow
  // that stopped at the middle step would prove durability while leaving the
  // thing a member actually cares about — that the write eventually lands —
  // entirely unobserved.
  //
  // iOS IS AN HONEST GAP HERE, not an oversight. `setAirplaneMode` is a Maestro
  // Android command (it drives the emulator's radio); the iOS Simulator exposes
  // no airplane control to any CLI Maestro can reach, so there is no way to take
  // this device offline on that side at all. The same store/read contract is
  // held on every platform by the integration companion named in the else-branch
  // below, but the OS-level disconnect/reconnect is Android-only until the
  // Simulator gains a switch a driver can throw. Nothing here may be "ported"
  // to iOS by faking offline in JS — a faked radio proves the fake.
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
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
${AWAIT_LAUNCHER}${OPEN_TALLY}
- extendedWaitUntil:
    visible: "${BALANCES_STATUS}"
    timeout: 20000
# Into one group's ledger WHILE THE GATEWAY STILL ANSWERS. The composer divides
# between the group's own members, and those arrive with the group payload; a
# member who opens the composer with no landed group has nobody to divide
# between, which is a fact about the read plane and not about this flow.
#
# The band destination is taken by its KEY, not its label: tally-band-groups
# is what tally-band.ts already keys on, while "Groups" is copy the shelf
# table may re-word. A band tab stays on screen after it is tapped, so the
# conditional-retry helper would never stop retrying — Maestro's own
# retryTapIfNoChange plus the destination assertion is the right instrument,
# exactly as in agenda-week.mjs and tasks-board.mjs.
- tapOn:
    id: "tally-band-groups"
    retryTapIfNoChange: true
- extendedWaitUntil:
    visible: "${GROUPS_STATUS}"
    timeout: 20000
${retryableTapCommands(DEMO_GROUP, GROUPS_STATUS)}
- extendedWaitUntil:
    visible: "${GROUP_HERO_SUB}"
    timeout: 20000
- setAirplaneMode: enabled
# The ledger section's own verb (TallyGroupScreen.tsx, the Section act), and it
# is UNDER THE FOLD: the group route draws the hero, Settle up / Simplify, then
# the whole MEMBERS list before the ledger, so on a Pixel 6 the four demo
# members push this act off screen. tapOn does not scroll, so it failed
# outright against a screen that was drawing the control perfectly well —
# the same shape as the springboard tiles above (#905). Scrolled at full
# visibility for the same reason: Maestro matches an element the fold clipped.
- scrollUntilVisible:
    element:
      text: "Add expense"
    direction: DOWN
    visibilityPercentage: 100
    timeout: 20000
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
#
# Scrolled to first, because the composer is longer than a Pixel 6: What was
# it, How much, Paid by, Group, Category and When all precede the foot, and the
# digest of the run that found this ends at "Yesterday" with the foot and the
# commit button below it. Third instance of the same shape in this flow (#905).
- scrollUntilVisible:
    element:
      text: "Lands in ${DEMO_GROUP}.*"
    direction: DOWN
    visibilityPercentage: 100
    timeout: 20000
- assertVisible: "Lands in ${DEMO_GROUP} . queued on this device until the gateway answers"
# The commit sits BELOW the foot and is the ScrollView's last child
# (TallyAddScreen.tsx), so scrolling the foot to full visibility leaves the
# button itself still under the edge — which is how the tap below failed on run
# 33553387446 with the assertion above it passing. One more scroll pins to the
# bottom, where the two adjacent last elements are both on screen; it cannot
# overshoot, there being nothing after the button to scroll to.
- scroll
- tapOn:
    text: "Add expense"
    below: "Lands in ${DEMO_GROUP}.*"
# Waiting is the band's fourth place and the one surface that reads the durable
# outbox rather than the gateway. Its key is contrib — the label "Waiting" is
# copy shelves.ts owns, the key is the contract.
- tapOn:
    id: "tally-band-contrib"
    retryTapIfNoChange: true
- extendedWaitUntil:
    visible: "${WAITING_STATUS}"
    timeout: 20000
- assertVisible: "QUEUED"
- assertVisible: "${QUEUED_REASON}"
- takeScreenshot: native-airplane-pending-before-restart
- stopApp
- launchApp:
    clearState: false
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
${AWAIT_LAUNCHER}${OPEN_TALLY}
- extendedWaitUntil:
    visible: "${BALANCES_STATUS}"
    timeout: 30000
- tapOn:
    id: "tally-band-contrib"
    retryTapIfNoChange: true
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

      // ─── The radio comes back (#890 W4) ───────────────────────────────────
      // Restoring the network is its own chunk so the app is FOREGROUNDED and
      // on Waiting when the radio returns — the state a member is in when a
      // train leaves a tunnel. `native-session.ts` flushes the outbox on
      // AppState changes and on every session open, so the relaunch below is
      // what makes the drain deterministic rather than a race against backoff.
      await ctx.run(
        `appId: ${ctx.state.appId}
---
- setAirplaneMode: disabled
`,
        "airplane-reconnect"
      );
      await ctx.run(
        `appId: ${ctx.state.appId}
---
- stopApp
- launchApp:
    clearState: false
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
${AWAIT_LAUNCHER}${OPEN_TALLY}
- extendedWaitUntil:
    visible: "${BALANCES_STATUS}"
    timeout: 30000
- tapOn:
    id: "tally-band-contrib"
    retryTapIfNoChange: true
- extendedWaitUntil:
    visible: "${WAITING_STATUS}"
    timeout: 30000
# THE ROUND TRIP CLOSES, IN THE SURFACE'S OWN WORDS. contrib-model.ts drops an
# EXECUTED intent from Waiting entirely — "it settled, and the ledger below is
# where it now lives" — so the settled state of this device's outbox is the
# in-flight section saying it is empty, not a row that turned green. The budget
# is the gateway handshake plus one drain, not a render, so it is generous.
- extendedWaitUntil:
    visible: "Nothing in flight."
    timeout: 180000
# …and the empty sentence is not vacuous: this is still Waiting (its own scope
# line is on screen) and the queued row's reason is gone from it.
- assertVisible: "${WAITING_SCOPE}"
- assertNotVisible: "${QUEUED_REASON}"
- takeScreenshot: native-airplane-settled-after-reconnect
`,
        "airplane-settled-after-reconnect"
      );
      ctx.note(
        "Android: with the radio restored the queued expense left the outbox on its own — Waiting drew its empty in-flight section and no queued reason"
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
      "iOS Simulator has no Maestro airplane control, so the offline write → process death → reconnect → settled round trip is an honest iOS gap; the store/read half of the same contract is covered on every platform by apps/mobile/src/apps/tally/PendingRestartJourney.test.tsx"
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
    "All eight native blueprint covers and Settings survived navigation and a process restart; Android also completed the offline write → process restart → reconnect → settled round trip."
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
      "all eight native blueprint covers, Settings via the all-apps sheet, and process-restart smoke passed",
  };
});
