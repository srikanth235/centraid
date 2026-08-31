// The Locker seat on the phone (home-journey roster, issue #839 G8).
//
// What only a device can falsify here: the SEAL. Locker is the one app Home is
// forbidden to read — `useSpringboardTiles` leaves its count undefined on
// purpose so a sealed Locker never votes the vault empty — and the phone must
// arrive on the unlock gate and nothing else. Neither half is falsifiable below
// the device: a component test renders whichever state it was handed, and the
// process-restart half needs a real OS process to kill.
//
// Locker ships NO demo scenario (packages/blueprints/apps/locker has no
// seed.js), which is why this flow seeds Docs instead — not for content, but
// because Home draws the launcher grid only once some tile has content
// (screens/home/springboard-policy.ts); on a wholly empty vault Home renders the
// day-one treatment and there is no Locker tile to tap.
//
// Four claims, in order:
//   1. HOME WITHHOLDS THE COUNT: the tile speaks "Open Locker, locked" — the
//      withheld-count label, never "0 locked".
//   2. THE COVER STATES ITS OWN BOUNDARY: the setup route's ambient sentence,
//      "Nothing is browsable until there is a passphrase" — the v17 app bar
//      carries each route's own status line (`view-copy.ts` ROUTE_STATUS),
//      which is where the pre-v17 "Secrets stay online-only" subtitle went.
//   3. THE GATE REFUSES AT REST: the first-run gate is drawn and its own
//      control is disabled, because an empty field is under the 12-character
//      floor.
//   4. THE SEAL SURVIVES THE PROCESS: after a stopApp + relaunch, the same gate.
//
// Every assertion is on copy or an accessibilityLabel only the asserted screen
// publishes (issue #483's non-vacuous rules; this file is listed in
// scripts/lint-e2e-flows.mjs).

import {
  openHomeAppCommands,
  retryableTapCommands,
} from "../lib/first-run.mjs";
import {
  FIRST_LAUNCH_TIMEOUT_MS,
  HOME_READY_MARKER,
  runFlow,
} from "../lib/harness.mjs";

/** The gate as Maestro sees it: the wall itself, the floor it states, and the
 *  control that refuses while the field is empty. Asserted twice — once on
 *  arrival and once after the process restart — so the two chunks cannot drift.
 *
 *  THE HANDLE FINDS IT, THE SENTENCE IS THE CLAIM (#890 W2). `locker-gate` and
 *  `locker-gate-submit` are how a flow reaches the wall and its one control;
 *  the passphrase floor and the disabled state are what the seat PROMISES, so
 *  both stay asserted as copy and as state beside their handles. Dropping
 *  either half would leave a gate that is present but says nothing, or a
 *  sentence with no control under it. */
const GATE_ASSERTIONS = `- assertVisible:
    id: "locker-gate"
- assertVisible: "Twelve characters at least, the only way in that cannot be revoked.*"
- assertVisible:
    id: "locker-gate-submit"
    enabled: false
- assertVisible:
    text: "Create it"
    enabled: false`;

await runFlow("locker-gate", async (ctx) => {
  // Not locker's own scenario — locker has none. See the header.
  await ctx.ensureDemo("docs");
  await ctx.configureGateway();
  await ctx.run(
    `appId: ${ctx.state.appId}
---
# The withheld count, spoken. "Open Locker, 0 locked" would mean Home had begun
# reading the one app it must not. The tile's handle is asserted first so the
# sentence cannot pass on a Home that drew no Locker tile at all — the label is
# the claim, the handle is what proves there is something carrying it.
- assertVisible:
    id: "home-tile-locker"
- assertVisible: "Open Locker, locked"
${openHomeAppCommands("locker", "Open Locker.*")}
- extendedWaitUntil:
    visible: "Choose a passphrase"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- assertVisible: "Nothing is browsable until there is a passphrase"
${GATE_ASSERTIONS}
- takeScreenshot: locker-gate
`,
    "sealed-on-arrival"
  );

  await ctx.restart();

  await ctx.run(
    `appId: ${ctx.state.appId}
---
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
${openHomeAppCommands("locker", "Open Locker.*")}
- extendedWaitUntil:
    visible: "Choose a passphrase"
    timeout: 30000
${GATE_ASSERTIONS}
- takeScreenshot: locker-gate-after-restart
`,
    "sealed-after-restart"
  );
  ctx.note(
    "Home never published a Locker count; the cover opened on its gate before and after an OS process restart"
  );
  return {
    pass: true,
    notes:
      "Locker stayed sealed: withheld count on Home, refusing first-run gate, unchanged across a process restart",
  };
});
