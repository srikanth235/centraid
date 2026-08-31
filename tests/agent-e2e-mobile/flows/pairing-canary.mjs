// The shared-prerequisite canary (#890). It runs FIRST, alone, before anything
// fans out, and it proves exactly three things — no more:
//
//   1. the gateway is reachable and mints a pairing ticket,
//   2. the device is booted with the dev build installed (setup()'s own
//      preconditions, which throw before this body runs), and
//   3. a ticket redeems all the way through onboarding to a ready Home.
//
// WHY IT EXISTS. Every committed journey depends on those three, and today a
// break in any of them costs the WHOLE nightly before anyone learns the answer
// was "pairing": each of the ~19 flows discovers the same broken prerequisite
// independently, pays its own timeout discovering it, and reports it as its own
// unrelated-looking failure. One red canary in a few minutes replaces that.
//
// IT ASSERTS NOTHING APP-SPECIFIC, deliberately. The moment this flow knows
// about Photos or Docs it acquires a second reason to go red, and a canary with
// two reasons to fail no longer answers the question it was asked. Everything
// below the Home marker belongs to the journey that claims it.

import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { HOME_READY_MARKER, runFlow } from "../lib/harness.mjs";

/**
 * Where the desktop journeys publish their UI-impact frames, and now the one
 * mobile frame that survives a red suite (#905).
 */
const UI_IMPACT_DIR = "artifacts/e2e/ui-impact";
const HOME_FRAME = "issue-905-mobile-paired-home.png";

// The claim: a broken prerequisite is known in single-digit minutes, not after
// the fan-out. This is asserted on the flow's own wall clock AFTER the fact —
// it is a budget, not an interrupt. A genuinely unreachable gateway or an
// unpaired device fails in seconds to two minutes, which is the case that
// matters; a wedged Maestro driver is still bounded by the harness's own
// MAESTRO_CHUNK_TIMEOUT_MS, and the canary cannot make that shorter without
// making the honest slow-CI pairing flake.
const BUDGET_MS = 5 * 60_000;

await runFlow("pairing-canary", async (ctx) => {
  const startedAt = Date.now();

  // Mints the ticket over the gateway lane the rig is configured for, clears
  // the client, redeems through the real ticket-only onboarding UI, and lands
  // on Home. Every failure mode of the three claims above surfaces inside it.
  await ctx.configureGateway();

  // configureGateway already waited for Home. Re-observing it in a chunk of
  // this flow's own is what makes the canary's verdict self-contained: the
  // marker is asserted here, in this file, so a future change to the helper's
  // internals cannot quietly leave the canary passing on nothing.
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- assertVisible: "${HOME_READY_MARKER}"
- takeScreenshot: paired-home
`,
    "canary-home"
  );

  // ─── The paired-Home frame, published (#905) ─────────────────────────────
  //
  // The canary is the only flow that currently REACHES Home — every journey
  // behind it dies at its first tile tap — so its frame is the only picture of
  // the launcher any run still produces. That picture is also the one artifact
  // that tells the two launcher-empty states apart: every tile `unknown` draws
  // a populated grid since #905, while every tile `empty` routes to DayOne and
  // draws no launcher at all. From the Maestro log the two are identical.
  //
  // PUBLISHING IS NOT ASSERTING, which is what keeps the doctrine above
  // intact — no app-specific claim, and no second reason to go red. A failed
  // copy is noted and swallowed: the canary's verdict is about pairing, and
  // the suite behind it must not fall over a file copy.
  const screenshot = async () => {
    const frames = await readdir(ctx.state.screenshotsDir);
    const home = frames.find((frame) => frame.endsWith("-paired-home.png"));
    if (home === undefined)
      throw new Error("paired-home frame was not captured");
    await mkdir(UI_IMPACT_DIR, { recursive: true });
    await copyFile(
      path.join(ctx.state.screenshotsDir, home),
      path.join(UI_IMPACT_DIR, HOME_FRAME)
    );
  };
  try {
    await screenshot();
  } catch (error) {
    ctx.note(`paired-home frame not published: ${error.message}`);
  }

  const elapsedMs = Date.now() - startedAt;
  ctx.note(`prerequisites proven in ${Math.ceil(elapsedMs / 1000)}s`);
  if (elapsedMs >= BUDGET_MS) {
    // Over budget with the claims intact is still a failure: the canary's value
    // IS its speed. A slow canary has stopped being a canary and become the
    // first flow of the nightly.
    return {
      pass: false,
      notes: `pairing prerequisites took ${Math.ceil(elapsedMs / 1000)}s, over the ${BUDGET_MS / 60_000}-minute canary budget`,
    };
  }
  return {
    pass: true,
    notes: "gateway mints a ticket, device is paired, Home is ready",
  };
});
