// The Tasks seat on the phone (home-journey roster, issue #839 G8).
//
// What only a device can falsify here: the board's ARITHMETIC reaching the
// screen. Tasks imports its grouping from the blueprint (`todayGroups`,
// `upcomingGroups`) and its nesting from `useTasks`, and both are already
// covered as pure functions — what no unit layer proves is that the rows the
// phone's replica hands them are the rows the vault holds, and that the group a
// row lands in is the group the screen draws.
//
// Three claims, in order:
//   1. OVERDUE IS ITS OWN GROUP WITH ITS OWN VERB: `Move all to today` is drawn
//      only on a group `todayGroups` flagged `attention`, which is the overdue
//      group alone.
//   2. ITS META IS A COUNT AND A REASSURANCE: `overdueMeta` renders
//      `N · nothing was deleted`; the digit is part of the assertion.
//   3. A FAMILY TRAVELS WITH ITS PARENT: `useTasks` nests subtasks under their
//      parent and drops them from the top level, so a seeded subtask can only
//      appear on Upcoming as a CHILD of its dated parent.
//
// Every assertion is on copy or an accessibilityLabel only the asserted screen
// publishes (issue #483's non-vacuous rules; this file is listed in
// scripts/lint-e2e-flows.mjs).

import { retryableTapCommands } from "../lib/first-run.mjs";
import { FIRST_LAUNCH_TIMEOUT_MS, runFlow } from "../lib/harness.mjs";

await runFlow("tasks-board", async (ctx) => {
  await ctx.ensureDemo("tasks");
  await ctx.configureGateway({ fillSampleContent: true });
  await ctx.run(
    `appId: ${ctx.state.appId}
---
${retryableTapCommands("Open Tasks.*")}
# The overdue group's own verb. "Today" and "Overdue" are bare group labels and
# are deliberately not the arrival marker — this string is drawn only on a
# group todayGroups() flagged for attention, which is the overdue group alone.
- extendedWaitUntil:
    visible: "Move all to today"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- assertVisible: "[1-9][0-9]* · nothing was deleted"
- assertVisible: "Rotate the tires before the drive"
- takeScreenshot: tasks-today
`,
    "today-board"
  );
  await ctx.run(
    `appId: ${ctx.state.appId}
---
# A band tab stays on screen after it is tapped, so the conditional-retry
# helper would never stop retrying. Maestro's own retryTapIfNoChange plus the
# destination assertion below is the right instrument for a surface switch.
- tapOn:
    text: "^Upcoming$"
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
  return {
    pass: true,
    notes:
      "seeded board separated overdue with its own verb and Upcoming carried a project's nested subtask",
  };
});
