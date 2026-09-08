// FRAME-LEVEL CAPTURE / SHARE-IN (#890 W5, unblocked by ctx.device).
//
// The one act in the seat-verb register that begins in ANOTHER app. Everything
// else the mobile roster drives starts with a tap inside Centraid; this starts
// with the OS handing Centraid a payload it did not ask for, which is the whole
// reason it was recorded as a gap: Maestro drives one app under test and has no
// directive that means "share something to it from somewhere else".
//
// `ctx.device` is the missing piece, and the command is not exotic — Android's
// activity manager can synthesise the exact intent a share sheet sends:
//
//     adb -s <udid> shell am start -a android.intent.action.SEND \
//         -t text/plain --es android.intent.extra.TEXT "<payload>" <appId>
//
// ANDROID ONLY, and that is a fact rather than a shortcut. iOS has no
// equivalent: a share into a simulator needs a SECOND app to share FROM, which
// the lane does not install. `notes.capture` in origin-acts.json records that
// remaining half rather than letting this flow imply both platforms.
//
// ─── THE CLAIM ──────────────────────────────────────────────────────────────
// A text share from outside lands on Quick capture WITH THE SHARED TEXT IN THE
// FIELD. The second half is the one that matters. `ShareIntentIngest` routes
// through `centraid://capture?text=<encoded>`, so a build that opened the right
// screen while dropping or mangling the payload is a real regression that
// "Quick capture is visible" would sail past — and percent-encoding a user's
// text through a URL is exactly where that breaks.
//
// The payload deliberately contains a space and an apostrophe. Both survive
// `encodeURIComponent`, which is the product behaviour under test — and both are
// also exactly what the `adb shell` layer in between destroys if the value is
// not shell-quoted for the device, which is why it is passed through `shQuote`.
//
// ─── STATUS ─────────────────────────────────────────────────────────────────
// NEVER RUN — written without an emulator, verified statically only, and staged
// as `promoting` in roster.json so it cannot gate a PR until real nights back
// it. Every selector below is traced to shipped source:
//   - "Quick capture" and "Close quick capture" — apps/mobile/src/screens/Capture.tsx
//   - the routing — apps/mobile/src/kit/hooks/ShareIntentIngest.tsx

import {
  FIRST_LAUNCH_TIMEOUT_MS,
  HOME_READY_MARKER,
  runFlow,
  // Used by the `am start` payload below. It was MISSING until #915 Wave 2, and
  // the flow died with `ReferenceError: shQuote is not defined` on the
  // 2026-09-01 nightly (run 33498199941) — after its six preceding assertions
  // had passed, so the suite classified it as a product failure. A `promoting`
  // member that has never run is exactly where an unimported name survives:
  // nothing at any tier evaluates the module body, and the reference sits two
  // thirds of the way down a file nobody executes.
  shQuote,
} from "../lib/harness.mjs";

await runFlow("share-intent-in", async (ctx) => {
  if (ctx.state.platform !== "android") {
    // Not a silent skip: the verdict records WHY, so an iOS lane reading this
    // flow's absence finds the reason rather than an unexplained hole.
    ctx.note(
      "iOS has no `am start` equivalent — a share into the simulator needs a second app to share FROM, which the lane does not install. Tracked as the remaining half of notes.capture in origin-acts.json."
    );
    return { pass: true, skipped: "android-only act" };
  }

  await ctx.configureGateway();

  // Per-run, so yesterday's share cannot satisfy today's assertion.
  const payload = `Shared from another app ${ctx.state.runId} — Priya's list`;

  await ctx.run(
    `appId: ${ctx.state.appId}
---
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
`,
    "paired-home"
  );

  // THE ACT. Sent while the app is running and foregrounded, which is the
  // common case and the one `ShareIntentIngest`'s `ready` guard is about: the
  // hook discards a share that arrives before the replica session is up, so
  // firing this at a cold app would test the discard path instead.
  await ctx.device(
    [
      "shell",
      "am",
      "start",
      "-a",
      "android.intent.action.SEND",
      "-t",
      "text/plain",
      "--es",
      "android.intent.extra.TEXT",
      // SHELL-QUOTED for the DEVICE's sh, not the host's. `adb shell` joins argv
      // with spaces and does not escape, so an unquoted payload would split into
      // words — the extra binding only to "Shared" — and the apostrophe in
      // "Priya's" would open a quote that never closes, failing the command
      // before the flow asserted anything. See shQuote in lib/harness.mjs.
      shQuote(payload),
      ctx.state.appId,
    ],
    { label: "share-intent" }
  );
  ctx.note("ACTION_SEND delivered from outside the app");

  await ctx.run(
    `appId: ${ctx.state.appId}
---
# The screen. Its own title, published by Capture.tsx and nowhere else.
- extendedWaitUntil:
    visible: "Quick capture"
    timeout: 30000
- assertVisible: "Close quick capture"
# THE PAYLOAD, which is the half a wrong-but-plausible build loses. The composer
# is a multiline TextInput whose node text is the value it was opened with, so
# the shared string is directly assertable — and the apostrophe and spaces in it
# are what a concatenation that skipped encodeURIComponent would mangle.
- assertVisible: "${payload}"
- takeScreenshot: share-intent-in
`,
    "capture-prefilled"
  );
  ctx.note("Quick capture opened carrying the shared text verbatim");
});
