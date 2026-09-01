// The Docs seat on the phone (home-journey roster, issue #839 G8).
//
// What only a device can falsify here: the seeded drive reaching the native
// Docs cover through the replica, and the CLAIMED BAND's pop-not-push rule.
// `DocsScreen.tsx` navigates with `popTo("DocsHome", { destination })` because
// React Navigation 7's `navigate` pushes a SECOND `DocsHome` instead — a defect
// that is invisible to any unit or component test (both render one screen) and
// shows up only as a stack that grows a copy per band tap on a real device.
//
// Four claims, in order:
//   1. THE ALL SHELF COUNTS THE SEEDED DRIVE: `allStatus()` is copy this shelf
//      alone publishes, and the digit in it is the replica's own document count.
//   2. A ROW OPENS THE READING SURFACE: `docs-breadcrumb` is drawn by
//      `DocsShelfHeader`, which no shelf on `DocsHome` renders, so it cannot
//      pass on the shelf the row was tapped from.
//   3. THE BAND POPS: tapping `Folders` FROM the pushed reading route lands on
//      the Folders shelf of the stack's home, proved by that shelf's own status
//      sentence, a seeded folder name, and the pushed header being GONE.
//   4. OFFLINE, A DOCUMENT WHOSE BYTES ARE ALREADY HERE STILL OPENS (#890 W4,
//      Android only). See the airplane chunk at the foot for why "pin it first"
//      is answered by the seat with a sentence rather than a toggle.
//
// SELECTOR RULE (#890 W2): CHROME is found by handle (`docs-breadcrumb`,
// `docs-band-<key>`, `docs-row-first`), CONTENT by its own words — a seeded
// title, a seeded folder name and a status sentence carrying the replica's own
// count are the vault's strings, and finding a row by the text it should be
// carrying IS the assertion.
//
// Every assertion is on copy or an accessibilityLabel only the asserted screen
// publishes (issue #483's non-vacuous rules; this file is discovered by
// scripts/lint-e2e-flows.mjs).

import {
  openAppLinkCommands,
  retryableTapCommands,
} from "../lib/first-run.mjs";
import {
  FIRST_LAUNCH_TIMEOUT_MS,
  HOME_READY_MARKER,
  runFlow,
} from "../lib/harness.mjs";

/** `apps/docs/docs-copy.ts` allStatus — the All shelf's own foot sentence. A
 *  zero digit is the shape of a drive read that never reached the replica, so
 *  the digit is part of the assertion. It is NOT offline-sensitive: only the
 *  shelf CAPTION swaps when the gateway is out of reach (`view-copy.ts`
 *  captionFor), which is what the airplane chunk asserts instead. */
const ALL_STATUS = "[0-9,]+ · press and hold a row for quick actions";

/** `packages/blueprints/apps/docs/view-copy.ts` CAPTION_OFFLINE — the caption
 *  that replaces every shelf's own when the gateway is unreachable. */
const CAPTION_OFFLINE =
  "Titles, folders, filing and stars are read from this device; a row says what will not open.";

/** `apps/mobile/src/apps/docs/offline-pin.ts` INLINE_REASON — the seat's answer
 *  to "keep this on my phone" for a document whose bytes ride the inline
 *  `data:` door (#296), which is every document the demo scenario seeds. */
const INLINE_REASON =
  "This document's text travels in the replica, so it already opens offline.";

/** `view-copy.ts` rowStateMark case 4 — the mark a row takes offline when its
 *  bytes are NOT on this phone. Its absence is half of claim 4. */
const WILL_NOT_OPEN = "will not open";

await runFlow("docs-drive", async (ctx) => {
  await ctx.ensureDemo("docs");
  await ctx.configureGateway();
  await ctx.run(
    `appId: ${ctx.state.appId}
---
${openAppLinkCommands("docs")}
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

  // ─── Offline (#890 W4, Android only) ──────────────────────────────────────
  //
  // THE CLAIM AS THE PRODUCT ANSWERS IT. "Pin a document, then open it with the
  // gateway out of reach" assumes a pin to take; on this corpus there is none to
  // take, and that is the seat working rather than the seat missing something —
  // every seeded document's bytes ride the inline `data:` door, so they are
  // ALREADY on the phone and `offline-pin.ts` says so instead of offering a
  // toggle that would copy bytes to where they already are. So the pin half is
  // the sentence asserted above, and this half is what that sentence promises:
  // the gateway goes away, the process is killed, and the document still opens.
  //
  // Maestro's airplane control is Android-only (it drives the emulator's radio);
  // the iOS Simulator exposes none to any CLI, so this half is gated the way
  // native-v0-resilience.mjs gates its own. The relaunch is deliberate: it
  // proves the read comes off the replica on this device rather than out of a
  // cache the still-running process was holding.
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
${openAppLinkCommands("docs")}
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
