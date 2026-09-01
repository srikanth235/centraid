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
  openAppLinkCommands,
  retryableTapCommands,
} from "../lib/first-run.mjs";
import { FIRST_LAUNCH_TIMEOUT_MS, runFlow } from "../lib/harness.mjs";

/** Balances' own ambient sentence — `apps/tally/view-copy.ts` BALANCES_STATUS,
 *  drawn into the app bar by `TallyScreen.tsx` and published nowhere else. */
const BALANCES_STATUS =
  "Every figure is derived at read time . no balance is stored and none is transmitted";

/** The §6 hero sub-line, with the counts the figure was derived from. The
 *  numbers are the seeded vault's, so they are matched rather than pinned. */
const HERO_SUB = "Derived from .* expenses and .* settlements.*";

await runFlow("tally-derived", async (ctx) => {
  await ctx.ensureDemo("tally");
  await ctx.configureGateway();

  await ctx.run(
    `appId: ${ctx.state.appId}
---
${openAppLinkCommands("apps/tally")}
- extendedWaitUntil:
    visible: "${BALANCES_STATUS}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
# The figure names the rows it was derived from, so a member can go and count
# them. A stored balance would have no counts to name.
- assertVisible: "${HERO_SUB}"
- takeScreenshot: tally-balances-derived
`,
    "derived-at-read-time"
  );

  await ctx.run(
    `appId: ${ctx.state.appId}
---
# The band destination by its KEY — tally-band.ts and shelves.ts both key
# Waiting as contrib, while "Waiting" is the label those tables own and may
# re-word. A band tab stays on screen after it is tapped, so Maestro's own
# retryTapIfNoChange plus the destination assertion below is the right
# instrument, not the conditional-retry helper.
- tapOn:
    id: "tally-band-contrib"
    retryTapIfNoChange: true
- extendedWaitUntil:
    visible: "Every contribution says whose it is, where it is, and what it is waiting on"
    timeout: 30000
# Whose writes this seat can honestly account for — its own outbox.
- assertVisible: "Your own writes, from this device.*"
# THE HONEST-DOORS CLAIM. No mobile transport reaches the per-intent decide
# door, so neither verb may be drawn. Adding the buttons without the door
# turns exactly this red.
- assertNotVisible: "Approve"
- assertNotVisible: "Decline"
- takeScreenshot: tally-waiting-no-decide
`,
    "waiting-without-a-verb"
  );

  ctx.note(
    "Balances stated its derivation with the counts behind it; Waiting drew its own scope and neither Approve nor Decline"
  );
  return {
    pass: true,
    notes:
      "Tally derived every figure at read time and offered no verb this transport cannot fire",
  };
});
