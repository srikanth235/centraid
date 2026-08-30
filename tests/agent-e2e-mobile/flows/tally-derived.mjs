// The Tally seat on the phone (home-journey roster; issue #873 U3).
//
// What only a device can falsify here: that the phone's Tally cover DERIVES
// every figure at read time and draws no control it cannot fire.
//
// Two claims, in order:
//   1. NO BALANCE IS STORED, AND THE SCREEN SAYS SO WITH ITS ARITHMETIC. The
//      app bar carries Balances' own status line, and the hero's sub-line names
//      the COUNTS the figure came from — "Derived from N expenses and M
//      settlements". A cover that read a stored balance would have no counts to
//      name, and a component test cannot falsify this because it renders
//      whatever dashboard payload it is handed; only a real seeded vault makes
//      the counts the vault's own.
//   2. WAITING OFFERS NO VERB THIS SEAT CANNOT FIRE. The band's fourth slot is
//      Waiting because it is the only place a write can be somebody else's and
//      stuck — but no mobile transport reaches the gateway's per-intent decide
//      door, so the surface states whose writes it is showing and draws neither
//      Approve nor Decline. Their ABSENCE on a live screen is the assertion;
//      adding either button without adding the door turns this red.
//
// Both assertions are on copy the asserted screen alone publishes (issue #483's
// non-vacuous rules; this file is discovered by scripts/lint-e2e-flows.mjs).

import {
  DISMISS_KEYBOARD_ONBOARDING,
  retryableTapCommands,
} from "../lib/first-run.mjs";
import { SCREEN_TRANSITION_TIMEOUT_MS, runFlow } from "../lib/harness.mjs";

/** Balances' own ambient sentence — `apps/tally/view-copy.ts` BALANCES_STATUS,
 *  drawn into the app bar by `TallyScreen.tsx` and published nowhere else. */
const BALANCES_STATUS =
  "Every figure is derived at read time . no balance is stored and none is transmitted";

/** The §6 hero sub-line, with the counts the figure was derived from. The
 *  numbers are the seeded vault's, so they are matched rather than pinned. */
const HERO_SUB = "Derived from .* expenses and .* settlements.*";
const GROUPS_STATUS =
  "A group is a shared circle . members co-contribute from their own vaults";
const GROUP_HERO_SUB =
  "Every member computes this figure themselves, from the same facts.";
const ADD_STATUS =
  "Six ways to divide it . the method is recorded with the shares";
const DESCRIPTION_PLACEHOLDER = "Dinner at the Ship";
const AMOUNT_PLACEHOLDER = "0.00";
const QUEUED_REASON = ".*on a device, not in the vault yet.*";
const DEMO_GROUP = "Tahoe Trip";

await runFlow("tally-derived", async (ctx) => {
  await ctx.ensureDemo("tally");
  await ctx.configureGateway();

  await ctx.run(
    `appId: ${ctx.state.appId}
---
${retryableTapCommands("Open Tally.*")}
- extendedWaitUntil:
    visible: "${BALANCES_STATUS}"
    timeout: ${SCREEN_TRANSITION_TIMEOUT_MS}
# The figure names the rows it was derived from, so a member can go and count
# them. A stored balance would have no counts to name.
- assertVisible: "${HERO_SUB}"
- takeScreenshot: tally-balances-derived
`,
    "derived-at-read-time"
  );

  // Waiting is backed by this device's durable outbox, not the seeded ledger.
  // Maestro can create that state deterministically on Android by disconnecting
  // the emulator before composing an expense. iOS Simulator has no supported
  // airplane-mode command, so its pending-write companion remains the native
  // restart test rather than a vacuous device assertion.
  if (ctx.state.platform === "android") {
    const pendingExpense = `Pending contribution ${ctx.state.runId}`;
    try {
      await ctx.run(
        `appId: ${ctx.state.appId}
---
${retryableTapCommands("Groups", BALANCES_STATUS)}
- extendedWaitUntil:
    visible: "${GROUPS_STATUS}"
    timeout: 20000
${retryableTapCommands(DEMO_GROUP, GROUPS_STATUS)}
- extendedWaitUntil:
    visible: "${GROUP_HERO_SUB}"
    timeout: 20000
- setAirplaneMode: enabled
${retryableTapCommands("Add expense", GROUP_HERO_SUB)}
- extendedWaitUntil:
    visible: "${ADD_STATUS}"
    timeout: 20000
- tapOn: "${DESCRIPTION_PLACEHOLDER}"
- inputText: "${pendingExpense}"
- assertVisible: "${pendingExpense}"
${DISMISS_KEYBOARD_ONBOARDING}
- tapOn: "${AMOUNT_PLACEHOLDER}"
- inputText: "12.34"
- assertVisible: "12.34"
- hideKeyboard
- assertVisible: "Lands in ${DEMO_GROUP} . queued on this device until the gateway answers"
- tapOn:
    text: "Add expense"
    below: "Lands in ${DEMO_GROUP}.*"
${retryableTapCommands("Waiting", GROUP_HERO_SUB)}
- extendedWaitUntil:
    visible: "Every contribution says whose it is, where it is, and what it is waiting on"
    timeout: 20000
# A real queued outbox row is the precondition for the negative assertions.
- assertVisible: "QUEUED"
- assertVisible: "${QUEUED_REASON}"
- assertVisible: "Your own writes, from this device.*"
# THE HONEST-DOORS CLAIM. No mobile transport reaches the per-intent decide
# door, so neither verb may be drawn on this real pending row.
- assertNotVisible: "Approve"
- assertNotVisible: "Decline"
- takeScreenshot: tally-waiting-pending-no-decide
`,
        "waiting-with-pending-row"
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
    await ctx.run(
      `appId: ${ctx.state.appId}
---
- tapOn: "Waiting"
- extendedWaitUntil:
    visible: "Every contribution says whose it is, where it is, and what it is waiting on"
    timeout: 20000
- assertVisible: "Your own writes, from this device.*"
- takeScreenshot: tally-waiting-ios-surface
`,
      "waiting-surface-without-pending-claim"
    );
    ctx.note(
      "iOS proved the Waiting surface but made no withheld-verb claim without a real pending row; the native restart companion owns that state"
    );
  }

  ctx.note(
    "Balances stated its derivation with the counts behind it; Android also proved a real queued Waiting row offers neither Approve nor Decline"
  );
  return {
    pass: true,
    notes:
      "Tally derived every figure at read time and offered no verb this transport cannot fire",
  };
});
