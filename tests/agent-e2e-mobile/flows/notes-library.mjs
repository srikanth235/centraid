// The Notes seat on the phone (home-journey roster, issue #839 G8).
//
// What only a device can falsify here: the JOIN. A note's row and a note's body
// are two separate replica reads on this seat (`useNotes` composes the note rows
// with their content rows), and the promoted heading comes from the blueprint's
// own `promote()` rather than a second mobile spelling of it. A list of headings
// above empty previews is exactly what a dropped join looks like, and it is
// green on every fixture that hands the projection both halves already merged.
//
// Three claims, in order:
//   1. THE COVER IS THE ARRIVAL: `New note` is published by the Notes header
//      alone — never a tab label.
//   2. A ROW IS THE VAULT'S NOTE, PROMOTED, by the row's own accessible name.
//   3. THE PREVIEW IS THE NOTE'S BODY: the row renders it with newlines
//      collapsed to spaces, so the body's first instruction is a reachable
//      single-line node. This is the half a dropped join loses.
// Then the row opens the editor, proved by the modal's own three acts.
//
// Every assertion is on copy or an accessibilityLabel only the asserted screen
// publishes (issue #483's non-vacuous rules; this file is listed in
// scripts/lint-e2e-flows.mjs).

import { retryableTapCommands } from "../lib/first-run.mjs";
import { FIRST_LAUNCH_TIMEOUT_MS, runFlow } from "../lib/harness.mjs";

await runFlow("notes-library", async (ctx) => {
  await ctx.ensureDemo("notes");
  await ctx.configureGateway({ fillSampleContent: true });
  await ctx.run(
    `appId: ${ctx.state.appId}
---
${retryableTapCommands("Open Notes.*")}
- extendedWaitUntil:
    visible: "New note"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
# The row's own accessible name, built by the blueprint's promote().
- assertVisible: "Open Mom's chili, written down properly"
# …and the preview under it, which is the note's BODY. The row collapses the
# body's newlines to spaces, so this is one reachable single-line node rather
# than the multi-line block a whole-node regex cannot cross.
- assertVisible: ".*Brown 2 lb chuck in batches.*"
- takeScreenshot: notes-library
`,
    "reading-room"
  );
  await ctx.run(
    `appId: ${ctx.state.appId}
---
${retryableTapCommands("Open Mom's chili, written down properly", "New note")}
# The editor sheet's own controls. "Note title" / "Note body" are deliberately
# NOT asserted: they are accessibilityLabels on React Native TextInputs, which
# do not reach the iOS accessibility tree (README "Known caveats").
- extendedWaitUntil:
    visible: "Close the note"
    timeout: 30000
- assertVisible: "Save this note"
- assertVisible: "Move this note to trash"
- takeScreenshot: notes-editor
`,
    "editor-sheet"
  );
  return {
    pass: true,
    notes:
      "seeded library carried both the promoted heading and the note's own body, and the row opened the editor with its three acts",
  };
});
