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

import { ALLOW_PHOTOS_FULL_ACCESS } from "../lib/first-run.mjs";
import { findScreenshot, HOME_READY_MARKER, runFlow } from "../lib/harness.mjs";

// The claim: the product's pairing transition completes in five minutes, not
// after the fan-out. This is asserted from Maestro's completed-command receipt
// rather than the flow process wall clock: hosted XCUITest installation is
// infrastructure setup, while Connect → Home is the product latency this
// budget is meant to describe. A wedged driver still fails through the normal
// harness timeout and the suite deadline.
const BUDGET_MS = 5 * 60_000;

await runFlow("pairing-canary", async (ctx) => {
  // Mints the ticket over the gateway lane the rig is configured for, clears
  // the client, redeems through the real ticket-only onboarding UI, and lands
  // on Home. Every failure mode of the three claims above surfaces inside it.
  // The session option keeps the three short logical phases in one Maestro
  // process, so XCUITest startup is paid once and cannot masquerade as three
  // product failures.
  const pairing = await ctx.configureGateway({
    session: true,
    permissionCommands: ALLOW_PHOTOS_FULL_ACCESS,
    // Keep the canary's claim in this flow while executing it in the helper's
    // final phase. The helper reaches this extension point only after its own
    // mandatory Home wait; the retained screenshot is taken after the ticket
    // has been removed from the rendered state.
    homeCommands: `
- assertVisible: "${HOME_READY_MARKER}"
- takeScreenshot: paired-home
`,
  });

  const elapsedMs = pairing?.pairingTransitionMs;
  if (!Number.isFinite(elapsedMs)) {
    return {
      pass: false,
      notes: "pairing completed without a Connect-to-Home timing receipt",
    };
  }
  ctx.note(`pairing transition proven in ${Math.ceil(elapsedMs / 1000)}s`);
  if (elapsedMs >= BUDGET_MS) {
    // Over budget with the claims intact is still a failure: the canary's value
    // IS its speed. A slow canary has stopped being a canary and become the
    // first flow of the nightly.
    return {
      pass: false,
      notes: `Connect-to-Home pairing took ${Math.ceil(elapsedMs / 1000)}s, over the ${BUDGET_MS / 60_000}-minute product budget`,
    };
  }

  const uiImpactDir = "artifacts/e2e/ui-impact";
  const screenshot = async () => {
    const frames = await readdir(ctx.state.screenshotsDir);
    const pairedHome = findScreenshot(frames, "paired-home");
    if (pairedHome === undefined)
      throw new Error("paired Home frame was not captured");
    await mkdir(uiImpactDir, { recursive: true });
    await copyFile(
      path.join(ctx.state.screenshotsDir, pairedHome),
      path.join(uiImpactDir, "issue-908-ios-paired-home.png")
    );
  };
  await screenshot();
  return {
    pass: true,
    notes: "gateway mints a ticket, device is paired, Home is ready",
  };
});
