import {
  FIRST_LAUNCH_TIMEOUT_MS,
  HOME_READY_MARKER,
  runFlow,
  shQuote,
} from "../lib/harness.mjs";

await runFlow("share-intent-in", async (ctx) => {
  if (ctx.state.platform !== "android") {
    ctx.note(
      "iOS has no `am start` equivalent — a share into the simulator needs a second app to share FROM, which the lane does not install. Tracked as the remaining half of notes.capture in origin-acts.json."
    );
    return { pass: true, skipped: "android-only act" };
  }

  await ctx.configureGateway();

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
