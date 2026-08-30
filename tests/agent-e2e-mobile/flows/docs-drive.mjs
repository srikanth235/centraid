// The Docs seat on the phone (home-journey roster, issue #839 G8).
//
// What only a device can falsify here: the seeded drive reaching the native
// Docs cover through the replica, and the CLAIMED BAND's pop-not-push rule.
// `DocsScreen.tsx` navigates with `popTo("DocsHome", { destination })` because
// React Navigation 7's `navigate` pushes a SECOND `DocsHome` instead — a defect
// that is invisible to any unit or component test (both render one screen) and
// shows up only as a stack that grows a copy per band tap on a real device.
//
// Three claims, in order:
//   1. THE ALL SHELF COUNTS THE SEEDED DRIVE: `allStatus()` is copy this shelf
//      alone publishes, and the digit in it is the replica's own document count.
//   2. A ROW OPENS THE READING SURFACE: `Back to All` exists only on a pushed
//      Docs route, so it cannot pass on the shelf the row was tapped from.
//   3. THE BAND POPS: tapping `Folders` FROM the pushed reading route lands on
//      the Folders shelf of the stack's home, proved by that shelf's own status
//      sentence and a seeded folder name.
//
// Every assertion is on copy or an accessibilityLabel only the asserted screen
// publishes (issue #483's non-vacuous rules; this file is listed in
// scripts/lint-e2e-flows.mjs).

import { retryableTapCommands } from "../lib/first-run.mjs";
import { SCREEN_TRANSITION_TIMEOUT_MS, runFlow } from "../lib/harness.mjs";

await runFlow("docs-drive", async (ctx) => {
  await ctx.ensureDemo("docs");
  await ctx.configureGateway({ fillSampleContent: true });
  await ctx.run(
    `appId: ${ctx.state.appId}
---
${retryableTapCommands("Open Docs.*")}
# The All shelf's own foot sentence (docs-copy.ts allStatus). A zero digit is
# the shape of a drive read that never reached the replica, so the digit is
# part of the assertion.
- extendedWaitUntil:
    visible: "[0-9,]+ · press and hold a row for quick actions"
    timeout: ${SCREEN_TRANSITION_TIMEOUT_MS}
- assertVisible: "Tahoe packing list"
- assertVisible: "Renters insurance policy.*"
- takeScreenshot: docs-all-shelf
`,
    "all-shelf"
  );
  await ctx.run(
    `appId: ${ctx.state.appId}
---
${retryableTapCommands("Tahoe packing list", "[0-9,]+ · press and hold a row for quick actions")}
# Only a PUSHED Docs route draws this back control (DocsShelfHeader's
# "Back to <backTo>"), so it cannot pass on the shelf that was tapped from.
- extendedWaitUntil:
    visible: "Back to All"
    timeout: 30000
# The reading surface's byline — the document's real changed-time and size,
# not the "not in the drive this device can see" absence.
- assertVisible: "changed .*"
- takeScreenshot: docs-document-read
`,
    "document-read"
  );
  await ctx.run(
    `appId: ${ctx.state.appId}
---
# The band tap happens FROM the pushed reading route: DocsScreen popTo's the
# stack's home with the shelf named. A push instead would leave "Back to All"
# on screen and fail the assertNotVisible below.
${retryableTapCommands("^Folders$", "Back to All")}
- extendedWaitUntil:
    visible: "[0-9,]+ folders · a folder is a label, not a place"
    timeout: 30000
- assertVisible: "Travel"
- assertNotVisible: "Back to All"
- takeScreenshot: docs-folders-shelf
`,
    "folders-shelf"
  );
  return {
    pass: true,
    notes:
      "seeded drive counted the All shelf, a row opened the reading surface, and a band tap popped to the Folders shelf",
  };
});
