// The Tasks seat on the phone (home-journey roster, issue #839 G8).
//
// What only a device can falsify here: the board's ARITHMETIC reaching the
// screen. Tasks imports its grouping from the blueprint (`todayGroups`,
// `upcomingGroups`) and its nesting from `useTasks`, and both are already
// covered as pure functions — what no unit layer proves is that the rows the
// phone's replica hands them are the rows the vault holds, and that the group a
// row lands in is the group the screen draws.
//
// Four claims, in order:
//   1. OVERDUE IS ITS OWN GROUP WITH ITS OWN VERB: `Move all to today` is drawn
//      only on a group `todayGroups` flagged `attention`, which is the overdue
//      group alone.
//   2. ITS META IS A COUNT AND A REASSURANCE: `overdueMeta` renders
//      `N · nothing was deleted`; the digit is part of the assertion.
//   3. A FAMILY TRAVELS WITH ITS PARENT: `useTasks` nests subtasks under their
//      parent and drops them from the top level, so a seeded subtask can only
//      appear on Upcoming as a CHILD of its dated parent.
//   4. QUICK ADD WRITES INTO THE GROUP THE SCREEN DRAWS (#890 W5). Every claim
//      above reads a seeded corpus; this one is the member's own keystrokes
//      going through `add_task` and landing where the grouping says they must.
//      `QUICK_ADD_EMPTY` files with no date and no project, and `quickAddLandsIn`
//      says so on screen before the tap — so the Inbox is not a guess, it is the
//      destination the capture bar itself names.
//
// SELECTOR RULE (#890 W2): CHROME is found by handle (`tasks-capture`,
// `tasks-move-all`, `tasks-group-attention`, `tasks-band-<key>`), CONTENT by its
// own words — a seeded title and a typed title are the vault's strings, and
// finding a row by the text it should carry IS the assertion.
//
// Every assertion is on copy or an accessibilityLabel only the asserted screen
// publishes (issue #483's non-vacuous rules; this file is discovered by
// scripts/lint-e2e-flows.mjs).

import { retryableTapCommands } from "../lib/first-run.mjs";
import {
  AWAIT_LAUNCHER,
  FIRST_LAUNCH_TIMEOUT_MS,
  runFlow,
} from "../lib/harness.mjs";

await runFlow("tasks-board", async (ctx) => {
  await ctx.ensureDemo("tasks");
  await ctx.configureGateway();

  // Unique per RUN: `ensureDemo` seeds only when the scenario is absent, so on
  // a long-lived gateway a task left behind by an earlier run would satisfy the
  // assertion below without this run writing anything at all.
  const capturedTask = `Captured on device ${ctx.state.runId}`;

  await ctx.run(
    `appId: ${ctx.state.appId}
---
${AWAIT_LAUNCHER}${retryableTapCommands("Open Tasks.*")}
# The overdue group's own verb. "Today" and "Overdue" are bare group labels and
# are deliberately not the arrival marker — this handle is on a group
# todayGroups() flagged for attention, which is the overdue group alone, and
# the verb's own copy is asserted beside it because that is what a member reads.
- extendedWaitUntil:
    visible:
      id: "tasks-group-attention"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- assertVisible:
    id: "tasks-move-all"
- assertVisible: "Move all to today"
- assertVisible: "[1-9][0-9]* · nothing was deleted"
- assertVisible: "Rotate the tires before the drive"
- takeScreenshot: tasks-today
`,
    "today-board"
  );

  // ─── The write (#890 W5) ──────────────────────────────────────────────────
  // ~30 s of marginal work on a journey that has already paid the boot, the
  // pairing and the seed: the capture bar is already drawn at the foot of the
  // board this chunk is standing on.
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- tapOn:
    id: "tasks-capture"
- inputText: "${capturedTask}"
# Asserted AT the field, where a swallowed keystroke actually happens — the same
# instrument native-v0-resilience.mjs uses on the Tally composer. tasks-capture
# IS the TextInput, and its whole node text is the typed value.
- assertVisible: "${capturedTask}"
# The capture bar states where the write will land BEFORE it is fired: with no
# When and no Where chosen, quickAddLandsIn() prints the Inbox. Asserting the
# promise here is what makes the Inbox assertion below a check rather than a
# hard-coded guess about the grouping.
- assertVisible: "Inbox · .*"
- hideKeyboard
- tapOn: "Add"
# capture() resets the draft to QUICK_ADD_EMPTY as it fires, so the chips pane
# folding away is the draft being consumed — and the typed title leaving the
# field is what makes the Inbox assertion below a read of a ROW rather than a
# second look at the same input. An undated, unfiled task is in neither of
# todayGroups()' two groups, so it is honestly absent from this board.
- extendedWaitUntil:
    notVisible: "Inbox · .*"
    timeout: 30000
- assertNotVisible: "${capturedTask}"
`,
    "quick-add"
  );

  await ctx.run(
    `appId: ${ctx.state.appId}
---
# The band destination by its KEY (tasks-band.ts already keys on it), never
# its label. A band tab stays on screen after it is tapped, so the
# conditional-retry helper would never stop retrying — Maestro's own
# retryTapIfNoChange plus the destination assertion is the right instrument.
- tapOn:
    id: "tasks-band-inbox"
    retryTapIfNoChange: true
# THE WRITE LANDED IN THE GROUP THE SCREEN DRAWS. A TaskRow publishes its title
# as its accessible name, and an undated, unfiled task exists in no other place
# on this board — so this row can only be the one the capture bar just wrote.
- extendedWaitUntil:
    visible: "${capturedTask}"
    timeout: 30000
- takeScreenshot: tasks-inbox-captured
`,
    "inbox-carries-the-write"
  );

  await ctx.run(
    `appId: ${ctx.state.appId}
---
- tapOn:
    id: "tasks-band-upcoming"
    retryTapIfNoChange: true
# The nearest dated day first — it is the top of the list.
- extendedWaitUntil:
    visible: "Book dentist appointment"
    timeout: 30000
# Then the NESTED subtask, seven days down a virtualized list. Scrolling to the
# CHILD is deliberate: the parent is the row immediately above it, so a downward
# scroll that brings the child into view leaves the parent on screen. The
# subtask is not a top-level row at all (useTasks drops children from the top
# level), so it can only be here as a child drawn under its dated parent.
- scrollUntilVisible:
    element:
      text: "Compare cabins.*"
    direction: DOWN
- assertVisible: "Plan the Tahoe trip"
- assertVisible: "Compare cabins.*"
- takeScreenshot: tasks-upcoming
`,
    "upcoming-board"
  );
  ctx.note(
    `a task captured on device landed in the Inbox the capture bar named: "${capturedTask}"`
  );
  return {
    pass: true,
    notes:
      "seeded board separated overdue with its own verb, a captured task landed in the Inbox the bar named, and Upcoming carried a project's nested subtask",
  };
});
