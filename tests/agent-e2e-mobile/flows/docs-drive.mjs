import { retryableTapCommands } from "../lib/first-run.mjs";
import {
  AWAIT_LAUNCHER,
  FIRST_LAUNCH_TIMEOUT_MS,
  HOME_READY_MARKER,
  runFlow,
} from "../lib/harness.mjs";

const ALL_STATUS = "[0-9,]+ · press and hold a row for quick actions";

const CAPTION_OFFLINE =
  "Titles, folders, filing and stars are read from this device; a row says what will not open.";

const INLINE_REASON =
  "This document's text travels in the replica, so it already opens offline.";

const WILL_NOT_OPEN = "will not open";

await runFlow("docs-drive", async (ctx) => {
  await ctx.ensureDemo("docs");
  await ctx.configureGateway();
  await ctx.run(
    `appId: ${ctx.state.appId}
---
${AWAIT_LAUNCHER}${retryableTapCommands("Open Docs.*")}
- extendedWaitUntil:
    visible: "${ALL_STATUS}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- assertVisible: "Tahoe packing list"
- assertVisible: "Renters insurance policy.*"
- takeScreenshot: docs-all-shelf
`,
    "all-shelf"
  );
  await ctx.run(
    `appId: ${ctx.state.appId}
---
${retryableTapCommands("Tahoe packing list", ALL_STATUS)}
# Only a PUSHED Docs route draws this header, so it cannot pass on the shelf
# that was tapped from. Handle AND label in one selector: the handle is the
# stack fact, the label is the frame's cross-app rule that a back control NAMES
# its destination rather than saying "Back".
- extendedWaitUntil:
    visible:
      id: "docs-breadcrumb"
      text: "Back to All"
    timeout: 30000
# The reading surface's byline — the document's real changed-time and size,
# not the "not in the drive this device can see" absence.
- assertVisible: "changed .*"
# WHAT "KEEP THIS ON MY PHONE" ANSWERS HERE. Every document the demo seeds
# carries its bytes as an inline data: URI (blueprints/apps/docs/seed.js), so
# useDocumentOfflinePin refuses the toggle and states why instead of offering
# a control that would change nothing. The sentence IS the claim — it is the
# promise the airplane chunk below then goes and checks.
- assertVisible: "${INLINE_REASON}"
- takeScreenshot: docs-document-read
`,
    "document-read"
  );
  await ctx.run(
    `appId: ${ctx.state.appId}
---
# The band tap happens FROM the pushed reading route: DocsScreen popTo's the
# stack's home with the shelf named. A push instead would leave the pushed
# header on screen and fail the assertNotVisible below. The destination is
# taken by its KEY — the band model already keys on it, while "Folders" is a
# label the copy may re-word. A band tab stays on screen after it is tapped, so
# Maestro's own retryTapIfNoChange plus the destination assertion is the right
# instrument, not the conditional-retry helper.
- tapOn:
    id: "docs-band-folders"
    retryTapIfNoChange: true
- extendedWaitUntil:
    visible: "[0-9,]+ folders · a folder is a label, not a place"
    timeout: 30000
- assertVisible: "Travel"
# THE POP. Asserted on the HANDLE rather than the words: an assertNotVisible on
# copy passes forever the day the copy is re-worded, which is the exact failure
# scripts/lint-mobile-testids.mjs exists to keep out — it holds the other end,
# so this id cannot quietly stop naming anything.
- assertNotVisible:
    id: "docs-breadcrumb"
- assertNotVisible: "Back to All"
- takeScreenshot: docs-folders-shelf
`,
    "folders-shelf"
  );

  if (ctx.state.platform === "android") {
    try {
      await ctx.run(
        `appId: ${ctx.state.appId}
---
- setAirplaneMode: enabled
- stopApp
- launchApp:
    clearState: false
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
${AWAIT_LAUNCHER}${retryableTapCommands("Open Docs.*")}
# The shelf still counts the drive — titles, folders, filing and stars are
# replica reads and owe the gateway nothing…
- extendedWaitUntil:
    visible: "${ALL_STATUS}"
    timeout: 60000
# …and the caption says which reads those are, replacing the one that promises
# "on this gateway". A caption still making that promise while the gateway is
# unreachable would be the one untrue sentence on screen.
- assertVisible: "${CAPTION_OFFLINE}"
# The leading row by its handle: which document it is does not matter here, only
# that a row the shelf drew opens with nothing to fetch it from.
- tapOn:
    id: "docs-row-first"
    retryTapIfNoChange: true
- extendedWaitUntil:
    visible:
      id: "docs-breadcrumb"
    timeout: 30000
# THE CLAIM. The byline is the document's own changed-time and size, and it is
# drawn only where a document was actually resolved — the absent case prints
# "not in the drive this device can see" instead.
- assertVisible: "changed .*"
- assertVisible: "${INLINE_REASON}"
# …and the row never took the offline refusal mark, which is what a document
# whose bytes are elsewhere gets (rowStateMark case 4).
- assertNotVisible: "${WILL_NOT_OPEN}"
- takeScreenshot: docs-opens-offline
`,
        "opens-with-the-gateway-out-of-reach"
      );
      ctx.note(
        "Android: with the radio off and the process killed, a seeded document still opened from the replica and the shelf swapped to its offline caption"
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
      "iOS Simulator has no Maestro airplane control, so the opens-offline half is an honest iOS gap; the projection it rests on is covered on every platform by apps/mobile/src/apps/docs/docs-projection.test.ts and offline-pin.test.ts"
    );
  }

  return {
    pass: true,
    notes:
      "seeded drive counted the All shelf, a row opened the reading surface, a band tap popped to the Folders shelf, and (Android) a document still opened with the gateway out of reach",
  };
});
