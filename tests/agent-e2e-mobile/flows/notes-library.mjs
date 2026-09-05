// The Notes seat on the phone (home-journey roster, issue #839 G8).
//
// What only a device can falsify here: the JOIN. A note's row and a note's body
// are two separate replica reads on this seat (`useNotes` composes the note rows
// with their content rows), and the promoted heading comes from the blueprint's
// own `promote()` rather than a second mobile spelling of it. A list of headings
// above empty previews is exactly what a dropped join looks like, and it is
// green on every fixture that hands the projection both halves already merged.
//
// Four claims, in order:
//   1. THE COVER IS THE ARRIVAL: `New note` is published by the Notes header
//      alone — never a tab label.
//   2. A ROW IS THE VAULT'S NOTE, PROMOTED, by the row's own accessible name.
//   3. THE PREVIEW IS THE NOTE'S BODY: the row renders it with newlines
//      collapsed to spaces, so the body's first instruction is a reachable
//      single-line node. This is the half a dropped join loses.
//   4. A WRITE ROUND-TRIPS AND SURVIVES PROCESS DEATH (#890 W5). Every claim
//      above reads a corpus the gateway seeded; this one is the member's own
//      keystrokes going down through `create-note`, into the replica, and back
//      out of a process that was killed in between. It is the PR gate's write
//      claim, so it is deliberately load-bearing rather than a smoke tap.
// Then the row opens the editor, proved by the modal's own three acts.
//
// SELECTOR RULE (#890 W2): CHROME is found by handle, CONTENT by its own words.
// `notes-capture`, `notes-editor-close`, `notes-row-first` and the band keys are
// product chrome whose copy may be re-worded; a seeded note's heading and a
// captured note's title are the vault's own strings, and finding a row by the
// text it should be carrying is the point of the assertion.
//
// Every assertion is on copy or an accessibilityLabel only the asserted screen
// publishes (issue #483's non-vacuous rules; this file is discovered by
// scripts/lint-e2e-flows.mjs).

import { retryableTapCommands } from "../lib/first-run.mjs";
import {
  AWAIT_LAUNCHER,
  FIRST_LAUNCH_TIMEOUT_MS,
  HOME_READY_MARKER,
  runFlow,
} from "../lib/harness.mjs";
import { screenshot } from "../lib/ui-impact.mjs";

/** `artifacts/e2e/ui-impact/issue-922-mobile-notes-library.png` — the Notes
 *  library, published as UI-impact evidence for #922 E.4 — the seat
 *  whose places and version history now draw through the kit's one virtualised
 *  list. Produced on the DEVICE RUNG; no container without a simulator emits
 *  it, which is why the copy is a note and never an assertion. */
const LIBRARY_FRAME = "issue-922-mobile-notes-library.png";

await runFlow("notes-library", async (ctx) => {
  await ctx.ensureDemo("notes");
  await ctx.configureGateway();

  // Unique per RUN, not per suite. `ctx.state.runId` carries a timestamp and
  // three random bytes, so a note left behind by yesterday's nightly on a
  // long-lived gateway cannot satisfy the survival assertion below — which is
  // exactly how a persistence claim quietly stops being one.
  const capturedNote = `Capture round trip ${ctx.state.runId}`;

  // ONE SPAWN FOR THE THREE READ/WRITE CHUNKS (#905). `pr-gate-budget.md`
  // names combining adjacent chunks as the first remedy for an overrun, and
  // each `ctx.run` costs ~9s of JVM start before its first command. Nothing
  // ran between these three but the next spawn.
  await ctx.run(
    `appId: ${ctx.state.appId}
---
# The launcher, before the tile. This journey reads a corpus seeded BEFORE
# pairing, so the grid is what the seeded vault is supposed to produce; waiting
# for the band alone let the tap land on DayOne.
${AWAIT_LAUNCHER}${retryableTapCommands("Open Notes.*")}
- extendedWaitUntil:
    visible: "New note"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
# The row's own accessible name, built by the blueprint's promote().
- assertVisible: "Open Mom's chili, written down properly"
# …and the preview under it, which is the note's BODY. The row collapses the
# body's newlines to spaces, so this is one reachable single-line node rather
# than the multi-line block a whole-node regex cannot cross. Taken by the
# preview's own handle as well: the row and the preview are two replica reads,
# and a dropped join loses the second one while the first still renders.
- assertVisible:
    id: "notes-row-first-preview"
- assertVisible: ".*Brown 2 lb chuck in batches.*"
- takeScreenshot: notes-library
${retryableTapCommands("Open Mom's chili, written down properly", "New note")}
# The editor sheet's own controls. "Note title" / "Note body" are deliberately
# NOT asserted: they are accessibilityLabels on React Native TextInputs, which
# do not reach the iOS accessibility tree (README "Known caveats").
- extendedWaitUntil:
    visible:
      id: "notes-editor-close"
    timeout: 30000
- assertVisible: "Close the note"
- assertVisible: "Save this note"
- assertVisible: "Move this note to trash"
- takeScreenshot: notes-editor
- tapOn:
    id: "notes-editor-close"
- extendedWaitUntil:
    visible:
      id: "notes-capture"
    timeout: 30000
- tapOn:
    id: "notes-capture"
- extendedWaitUntil:
    visible:
      id: "notes-editor-close"
    timeout: 30000
# The title field carries no handle and its accessibilityLabel ("Note title")
# does not reach the iOS accessibility tree, so its PLACEHOLDER is the only
# selector it publishes — the same shape the Tally composer is driven by above.
# A handle on this field is the one gap this journey still has; see the report
# on #890 W5 rather than inventing an id here, which would fail
# lint:mobile-testids the moment it is written.
- tapOn: "Title"
- inputText: "${capturedNote}"
# Asserted AT the field, where a swallowed keystroke actually happens — the same
# instrument native-v0-resilience.mjs uses on the Tally composer. The field is a
# single-line TextInput whose whole node text is the typed value, which is the
# case Maestro's matcher does handle.
- assertVisible: "${capturedNote}"
- hideKeyboard
- tapOn: "Save this note"
# THE WRITE LANDED IN THE LIBRARY, not merely in the field. The list is a
# different tree from the editor, sorted pinned-then-newest (notes-model.ts), so
# a note captured just now is the leading row. This is the read that matters:
# the field echo above proves the keyboard, the row proves the vault.
- extendedWaitUntil:
    visible:
      id: "notes-row-first"
      text: "Open ${capturedNote}"
    timeout: 30000
- takeScreenshot: notes-captured
`,
    "reading-room"
  );

  // A real OS process boundary — stopApp, then a relaunch that clears nothing.
  // Only the vault's own bytes cross it: React Navigation state is not
  // persisted, so the relaunch lands on Home and the cover is opened again.
  await ctx.restart();

  await ctx.run(
    `appId: ${ctx.state.appId}
---
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
${AWAIT_LAUNCHER}${retryableTapCommands("Open Notes.*")}
- extendedWaitUntil:
    visible: "New note"
    timeout: 30000
# THE CLAIM. Nothing of the writing process survived; the row can only have come
# back through the replica. Both halves are asserted — the handle proves the
# library drew a leading row at all, the text proves it is THIS run's note and
# not a leftover from a previous one against the same gateway.
- extendedWaitUntil:
    visible:
      id: "notes-row-first"
      text: "Open ${capturedNote}"
    timeout: 30000
- takeScreenshot: notes-captured-after-restart
`,
    "capture-survived-restart"
  );
  ctx.note(
    `a note captured on device came back after an OS process restart: "${capturedNote}"`
  );

  // PUBLISHING IS NOT ASSERTING: a failed copy is a note, never a second
  // reason for this journey to go red.
  try {
    await screenshot(ctx, "notes-library", LIBRARY_FRAME);
  } catch (error) {
    ctx.note(`notes library frame not published: ${error.message}`);
  }

  return {
    pass: true,
    notes:
      "seeded library carried both the promoted heading and the note's own body, the row opened the editor with its three acts, and a quick-captured note round-tripped through a process restart",
  };
});
