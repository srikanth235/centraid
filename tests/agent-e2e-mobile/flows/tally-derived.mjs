import { retryableTapCommands } from "../lib/first-run.mjs";
import {
  AWAIT_LAUNCHER,
  FIRST_LAUNCH_TIMEOUT_MS,
  runFlow,
} from "../lib/harness.mjs";

const BALANCES_STATUS =
  "Every figure is derived at read time . no balance is stored and none is transmitted";

const HERO_SUB = "Derived from .* expenses and .* settlements.*";

await runFlow("tally-derived", async (ctx) => {
  await ctx.ensureDemo("tally");
  await ctx.configureGateway();

  await ctx.run(
    `appId: ${ctx.state.appId}
---
${AWAIT_LAUNCHER}${retryableTapCommands("Open Tally.*")}
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
