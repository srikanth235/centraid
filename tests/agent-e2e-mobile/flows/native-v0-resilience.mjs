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
 * THE ROUTE TO TALLY, used at all three places this flow opens it.
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

/**
 * THE SETTINGS PLACE, used once per platform below.
 *
 * Settings is not a cover: it is a PLACE, reached from the band's More tab
 * through the all-apps sheet (`screens/home/AllAppsSheet.tsx`: "Settings is
 * reached from HERE, not from a drawer"). Every hop is taken by handle, and the
 * row is the last of the sheet's places half, so it is scrolled to at FULL
 * visibility — Maestro matches an element the sheet has clipped (README, "A
 * passing step is not a working step"). "APPEARANCE" is the first section
 * heading Settings publishes and nothing else in the app renders it, so it
 * proves arrival without a scroll.
 */
const OPEN_SETTINGS = `- tapOn:
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
    timeout: 20000
- assertVisible: "APPEARANCE"
- takeScreenshot: native-settings`;

await runFlow("native-v0-resilience", async (ctx) => {
  // The airplane journey below opens ONE GROUP'S LEDGER before it disconnects,
  // because that is the only path to the composer on a vault that is not on
  // day one, and because the group's payload has to be in memory for the
  // composer to know who the expense divides between. Seeded before pairing so
  // the corpus arrives in the first replica clone; the GET guard makes it a
  // no-op when another flow in the suite already seeded it.
  await ctx.ensureDemo("tally");
  await ctx.configureGateway();

  // NO COVER TOUR HERE (#905). "Every cover opens" is not a device-only claim:
  // `apps/mobile/src/screens/Home.test.tsx` generates a sweep from
  // `app-conformance.json` that proves every tile opens its cover, and each
  // cover has its own device journey on the per-merge canary. Per E-device-only
  // and `flows/pr-gate-budget.md` remedy 3, the claim lives at those tiers and
  // this flow keeps only what the device alone can show: the gate's one
  // airplane-mode journey, Settings through the all-apps sheet, and a process
  // restart.

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
    // The arc's own reconnect is the radio restore whenever it is reached; the
    // `finally` below is the cleanup for every path that never got there.
    let radioRestored = false;
    try {
      await ctx.run(
        `appId: ${ctx.state.appId}
---
# Settings comes first, off the Home this chunk inherits: configureGateway
# leaves the app on Home, so the place costs no launch of its own here. The
# stopApp/launchApp below is what returns to Home for the Tally arc.
${OPEN_SETTINGS}
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
# BY HANDLE, NOT BY COPY. "Add expense" is the commit's label AND the screen's
# own title, so a text tap needs a positional anchor to say which it meant —
# and on run 33559959847 that tap reported COMPLETED while the app stayed on the
# composer with no refusal drawn, which is what an ambiguous match looks like.
# tally-add-commit names the control itself (#905).
- tapOn:
    id: "tally-add-commit"
    retryTapIfNoChange: true
# ARRIVAL, NOT THE NEXT TAP — AND LONGER THAN THE GATEWAY'S OWN DEADLINE.
#
# The composer sets hideBand (TallyAddScreen), so the band cannot exist until
# commit has resolved and called goBack(); asserting the group screen instead of
# tapping the band is what turned "the Waiting tab is missing" into the true
# statement, which is that the composer never left.
#
# It never left because this wait was in a dead heat with the product's own
# timeout. Offline the write goes to the local tunnel, which keeps ACCEPTING
# after its peer is gone (docs/traps/unreachable-vault.md), so it cannot settle
# until GATEWAY_REPLY_DEADLINE_MS elapses — and that constant is 20_000, exactly
# what this wait used to be. Run 33567489343 tapped the commit at 22:56:18 and
# failed here at 22:56:38, to the second. The write was queueing as the flow
# gave up on it.
#
# THE BAND IS THE MARKER, because hideBand is the whole difference. The group
# hero's sentence was the first choice and it is only true ONLINE: the hero
# states a DERIVED balance, and offline that figure cannot be read, so the
# route draws its title, MEMBERS and LEDGER without it. Run 33573882728 proves
# the point from the other side — the digest at that failure is the group
# ledger, seeded expenses and all, so the commit HAD landed and the flow was
# asserting a sentence the offline screen never owed it.
#
# The band cannot be on the composer (hideBand) and is always on the group
# route, online or off, so it says exactly one thing: the composer left. 60s
# because the write settles behind a gateway deadline; extendedWaitUntil
# returns on arrival, so the ceiling costs nothing when it settles sooner.
- extendedWaitUntil:
    visible:
      id: "tally-band"
    timeout: 60000
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
      // Restoring the network is this chunk's FIRST command, ahead of the
      // stopApp, so the app is still foregrounded and on Waiting when the radio
      // returns — the state a member is in when a train leaves a tunnel. It was
      // a chunk of its own until #905 measured 11s of bare JVM start for one
      // directive (`flows/pr-gate-budget.md` remedy 1). `native-session.ts`
      // flushes the outbox on AppState changes and on every session open, so
      // the relaunch below is what makes the drain deterministic rather than a
      // race against retry backoff.
      await ctx.run(
        `appId: ${ctx.state.appId}
---
- setAirplaneMode: disabled
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
      radioRestored = true;
      ctx.note(
        "Android: with the radio restored the queued expense left the outbox on its own — Waiting drew its empty in-flight section and no queued reason"
      );
    } finally {
      // A FAILURE ANYWHERE EARLIER LEAVES THE EMULATOR ONLINE — that is the
      // invariant, and it is the only thing this chunk is for. Skipped once the
      // settled chunk has already restored the radio, because a second
      // `maestro test` for a directive that is a no-op costs 10s of JVM start
      // on every green run (#905, `flows/pr-gate-budget.md` remedy 1).
      if (!radioRestored)
        await ctx.run(
          `appId: ${ctx.state.appId}
---
- setAirplaneMode: disabled
`,
          "restore-network"
        );
    }
  } else {
    // No airplane chunk on this side, so the Settings hop is its own chunk here
    // — the claim holds on both platforms.
    await ctx.run(
      `appId: ${ctx.state.appId}
---
${OPEN_SETTINGS}
`,
      "settings-place"
    );
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
    "Settings opened from the all-apps sheet and the shell survived a process restart; Android also completed the offline write → process restart → reconnect → settled round trip."
  );

  // UI-impact evidence for #799: with the WebView app cover retired, Home's
  // launcher is the all-native surface — publish the post-restart Home frame
  // where the desktop journeys publish theirs.
  const uiImpactDir = "artifacts/e2e/ui-impact";
  // `takeScreenshot: <name>` LANDS AS `<name>.png`, WITH NO STEP PREFIX.
  // harness.mjs runs every chunk with `cwd = state.screenshotsDir`, and the
  // `NN-` prefix it mints belongs to the chunk's flow YAML and debug dir, not
  // to the frame; `--debug-output` only relocates Maestro's OWN per-step
  // captures. So a `-after-force-kill.png` suffix could never match, and run
  // 33582899886 failed here with every assertion of the arc already green.
  // The directory is still read rather than the file joined blind, so an
  // absent frame says so instead of surfacing as a copy's ENOENT.
  const screenshot = async () => {
    const frames = await readdir(ctx.state.screenshotsDir);
    const home = frames.find((frame) => frame === "after-force-kill.png");
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
    notes: "Settings via the all-apps sheet and process-restart smoke passed",
  };
});
