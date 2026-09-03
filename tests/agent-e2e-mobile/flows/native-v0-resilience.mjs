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

const BALANCES_STATUS =
  "Every figure is derived at read time . no balance is stored and none is transmitted";
const GROUPS_STATUS =
  "A group is a shared circle . members co-contribute from their own vaults";
const GROUP_HERO_SUB =
  "Every member computes this figure themselves, from the same facts.";
const ADD_STATUS =
  "Six ways to divide it . the method is recorded with the shares";
const WAITING_STATUS =
  "Every contribution says whose it is, where it is, and what it is waiting on";
const WAITING_SCOPE = "Your own writes, from this device.*";
const QUEUED_REASON = ".*on a device, not in the vault yet.*";
const DESCRIPTION_PLACEHOLDER = "Dinner at the Ship";
const AMOUNT_PLACEHOLDER = "0.00";
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

const DEMO_GROUP = "Tahoe Trip";

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
  await ctx.ensureDemo("tally");
  await ctx.configureGateway();

  if (ctx.state.platform === "android") {
    const airplaneExpense = `Airplane expense ${ctx.state.runId}`;
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

  const uiImpactDir = "artifacts/e2e/ui-impact";
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
