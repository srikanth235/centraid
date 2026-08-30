// SHARING, ON THE PHONE — the one commons producer this device has, and the
// one place an invitation is redeemed (#825 G-edit; #872 rebuilt the seat).
//
// Between #831 and the v17 rebuild no mobile seat could mint an invitation at
// all, and nothing on this layer noticed: the mobile journeys covered reading,
// recording and the gate, and sharing had no mobile-owned row. This flow is
// that row.
//
// THREE CLAIMS, in order:
//
//   1. THE VERB EXISTS, ON THE SUBJECT THAT CAN BE SHARED. `tally.group` is
//      v1's one edit-capable placeable subject (`_shared/placement-registry`),
//      so the group's own life-acts section is where a `centraid://commons-
//      invite` URI is minted — and the row says what an invitation IS before
//      it is pressed, rather than after.
//   2. THE SHEET IS REAL. Pressing it opens the shell's share engine, which
//      states the consequence of joining in its own words. What the sheet then
//      OFFERS depends on who this vault is linked to; see "what CI can prove"
//      in the .md — a single-vault fixture has nobody to hand an invitation to,
//      and the flow asserts the sheet, not a roster it does not have.
//   3. AN INVITATION IS REDEEMED SOMEWHERE, AND THAT SOMEWHERE LOADS. The
//      producing seat and the redeeming seat are different screens on the same
//      phone; Settings → Sharing is the second one, and its redemption field is
//      the door a `centraid://commons-invite` URI goes through.
//
// Plus, on Android only, the fourth: OFFLINE DRAWS THE SENTENCE, NOT THE VERB.
// Sharing is a commons compilation on the gateway and `MultiVaultReplicaSession
// .share` rejects while disconnected by design, so the row withholds the verb
// and says why — Due next's own shape — instead of offering a press that would
// fail. Maestro's airplane control is Android-only, which is why this half is
// gated; `apps/mobile/src/apps/tally/TallyShareGroup.test.tsx` owns the same
// claim at the component tier on every platform.
//
// Every asserted string is one the asserted screen alone publishes (issue
// #483's non-vacuous rules; this file is discovered by
// scripts/lint-e2e-flows.mjs).

import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { retryableTapCommands } from "../lib/first-run.mjs";
import {
  HOME_READY_MARKER,
  RELAUNCH_TIMEOUT_MS,
  SCREEN_TRANSITION_TIMEOUT_MS,
  runFlow,
} from "../lib/harness.mjs";

// Maestro reads a text selector as a regex anchored to the WHOLE node text,
// and `·` is not a character it matches reliably — so the shared sentences are
// spelled with `.` where the product uses a middle dot, as in `tally-derived`.

/** `apps/tally/view-copy.ts` BALANCES_STATUS — the Tally cover's app bar. */
const BALANCES_STATUS =
  "Every figure is derived at read time . no balance is stored and none is transmitted";
/** `apps/tally/view-copy.ts` ROUTE_STATUS.groups. */
const GROUPS_STATUS =
  "A group is a shared circle . members co-contribute from their own vaults";
/** `apps/tally/view-copy.ts` GROUP_HERO_SUB — one group's ledger, and nothing else. */
const GROUP_HERO_SUB =
  "Every member computes this figure themselves, from the same facts.";

/** `apps/mobile/src/apps/tally/tally-seat-copy.ts` — the seat's own three. */
const SHARE_VERB = "Share group";
const SHARE_META = "one invitation each, redeemed in their own vault";
const SHARE_OFFLINE =
  "Sharing needs a gateway connection . an invitation cannot be queued";

/** `apps/mobile/src/kit/share/ShareSheet.tsx` — the sheet's own consequence
 *  sentence, drawn whether or not this vault has anybody to share with. */
const SHEET_NOTE = "Everyone who joins gets the full shared item.*";

/** `apps/mobile/src/screens/Sharing.tsx` — the redemption section, whose title
 *  its local `Section` upper-cases, and the field's accessible name. */
const REDEEM_SECTION = "REDEEM A SHARED-SPACE INVITE";
const REDEEM_LEDE =
  "Create your vault first, then paste the one-time invitation here.";
const REDEEM_FIELD = "Shared-space invitation";

/** `apps/mobile/src/screens/Settings.tsx` — the row's visible label. Its
 *  accessible name is the bare word "Sharing", which the section heading above
 *  it also carries; the row's own sentence is the unambiguous target. */
const SHARING_ROW = "People, links and shared vaults";

/** `packages/blueprints/apps/tally/seed.js` — the one group the demo creates. */
const DEMO_GROUP = "Tahoe Trip";

await runFlow("sharing-invite", async (ctx) => {
  // A group is the subject being shared, so there has to be one. Seeded before
  // pairing so it arrives in the first replica clone; the GET guard makes a
  // second call a no-op.
  await ctx.ensureDemo("tally");
  // Pairing alone leaves Home in its intentionally empty state. Refresh the
  // deterministic demo projection so the Tally launcher is a real reachable
  // subject before the sharing assertion begins.
  await ctx.configureGateway({ fillSampleContent: true });

  await ctx.run(
    `appId: ${ctx.state.appId}
---
${retryableTapCommands("Open Tally.*")}
- extendedWaitUntil:
    visible: "${BALANCES_STATUS}"
    timeout: ${SCREEN_TRANSITION_TIMEOUT_MS}
${retryableTapCommands("Groups", BALANCES_STATUS)}
- extendedWaitUntil:
    visible: "${GROUPS_STATUS}"
    timeout: 20000
${retryableTapCommands(DEMO_GROUP, GROUPS_STATUS)}
- extendedWaitUntil:
    visible: "${GROUP_HERO_SUB}"
    timeout: 20000
# The life-acts section sits below the group's ledger, and the ledger is as
# long as the group is old.
- scrollUntilVisible:
    element:
      text: "${SHARE_VERB}"
    direction: DOWN
    timeout: 20000
# WHAT AN INVITATION IS, said before it is pressed: one each, and redeemed in
# the other person's own vault rather than granting access to this one.
- assertVisible: "${SHARE_META}"
- tapOn: "${SHARE_VERB}"
- extendedWaitUntil:
    visible: "${SHEET_NOTE}"
    timeout: 20000
- takeScreenshot: sharing-tally-group-sheet
- tapOn: "Cancel"
- extendedWaitUntil:
    visible: "${GROUP_HERO_SUB}"
    timeout: 20000
`,
    "share-a-group"
  );
  ctx.note(
    `Tally group "${DEMO_GROUP}" offered Share group with its own meta, and the share sheet opened on it`
  );

  // The redeeming seat. Settings is opened from the vault drawer, not the dock:
  // the dock sits where the dev build's LogBox toast parks itself, and a tap
  // right after launch lands on the toast, reports COMPLETED and navigates
  // nowhere. The drawer handle is top-right and is never covered.
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- stopApp
- launchApp:
    clearState: false
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${RELAUNCH_TIMEOUT_MS}
${retryableTapCommands("Open vault menu")}
- extendedWaitUntil:
    visible: "GO TO"
    timeout: 15000
# The row's accessible name is ", Settings" (icon + label collapsed into one
# element) and Maestro will not match a selector that starts with the comma.
${retryableTapCommands(".*Settings", "GO TO")}
- extendedWaitUntil:
    visible: "APPEARANCE"
    timeout: 20000
- scrollUntilVisible:
    element:
      text: "${SHARING_ROW}"
    direction: DOWN
    timeout: 20000
- tapOn: "${SHARING_ROW}"
- extendedWaitUntil:
    visible: "${REDEEM_SECTION}"
    timeout: 20000
# The door a centraid://commons-invite URI goes through, and the order it
# states: your own vault first, then the one-time invitation.
- assertVisible: "${REDEEM_LEDE}"
- assertVisible: "${REDEEM_FIELD}"
- takeScreenshot: sharing-redeem-surface
`,
    "redemption-surface"
  );
  ctx.note(
    "Settings → Sharing drew the invite-redemption section, its ordering sentence and its field"
  );

  // UI-impact evidence for #880 (check:ui-receipt): the two member-visible
  // surfaces this wave added on the sharing path — the Tally group's Share
  // group sheet, and the rebuilt Settings → Sharing screen — published where
  // the desktop and native journeys publish theirs. Copied out of the run dir
  // rather than re-captured, so what ships is the frame the assertions above
  // already passed against.
  const uiImpactDir = "artifacts/e2e/ui-impact";
  const screenshot = async (suffix, published) => {
    const frames = await readdir(ctx.state.screenshotsDir);
    const frame = frames.find((name) => name.endsWith(`-${suffix}.png`));
    if (frame === undefined)
      throw new Error(`${suffix} frame was not captured`);
    await mkdir(uiImpactDir, { recursive: true });
    await copyFile(
      path.join(ctx.state.screenshotsDir, frame),
      path.join(uiImpactDir, published)
    );
  };
  await screenshot(
    "sharing-tally-group-sheet",
    "issue-880-mobile-share-group-sheet.png"
  );
  await screenshot(
    "sharing-redeem-surface",
    "issue-880-mobile-sharing-screen.png"
  );

  if (ctx.state.platform === "android") {
    try {
      await ctx.run(
        `appId: ${ctx.state.appId}
---
- stopApp
- launchApp:
    clearState: false
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${RELAUNCH_TIMEOUT_MS}
${retryableTapCommands("Open Tally.*")}
- extendedWaitUntil:
    visible: "${BALANCES_STATUS}"
    timeout: ${SCREEN_TRANSITION_TIMEOUT_MS}
${retryableTapCommands("Groups", BALANCES_STATUS)}
- extendedWaitUntil:
    visible: "${GROUPS_STATUS}"
    timeout: 20000
${retryableTapCommands(DEMO_GROUP, GROUPS_STATUS)}
- extendedWaitUntil:
    visible: "${GROUP_HERO_SUB}"
    timeout: 20000
- scrollUntilVisible:
    element:
      text: "${SHARE_VERB}"
    direction: DOWN
    timeout: 20000
- assertVisible: "${SHARE_META}"
# The gateway goes out of reach UNDER a group that is already on screen: the
# ledger is a gateway read and would not land again, so this is the state a
# member is actually in when the radio drops.
- setAirplaneMode: enabled
- extendedWaitUntil:
    visible: "${SHARE_OFFLINE}"
    timeout: 30000
# THE WITHHELD VERB. The row now carries the sentence INSTEAD of what it offers
# when the gateway is reachable — not both, and not a greyed control.
- assertNotVisible: "${SHARE_META}"
- takeScreenshot: sharing-withheld-offline
`,
        "withheld-while-disconnected"
      );
      ctx.note(
        "Android: with the gateway out of reach the group drew the offline sentence and withdrew the invitation meta"
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
      "iOS Simulator has no Maestro airplane control; the withheld-verb half is covered on every platform by apps/mobile/src/apps/tally/TallyShareGroup.test.tsx"
    );
  }

  return {
    pass: true,
    notes:
      "the phone minted an invitation from a Tally group, and the surface that redeems one loaded",
  };
});
