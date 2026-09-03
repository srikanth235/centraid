import { retryableTapCommands } from "../lib/first-run.mjs";
import {
  AWAIT_LAUNCHER,
  FIRST_LAUNCH_TIMEOUT_MS,
  HOME_READY_MARKER,
  runFlow,
} from "../lib/harness.mjs";

await runFlow("notes-library", async (ctx) => {
  await ctx.ensureDemo("notes");
  await ctx.configureGateway();

  const capturedNote = `Capture round trip ${ctx.state.runId}`;

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

  return {
    pass: true,
    notes:
      "seeded library carried both the promoted heading and the note's own body, the row opened the editor with its three acts, and a quick-captured note round-tripped through a process restart",
  };
});
