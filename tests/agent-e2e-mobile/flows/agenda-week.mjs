// The Agenda seat on the phone (home-journey roster, issue #839 G8).
//
// What only a device can falsify here: the seeded week surviving the trip
// through the phone's replica into the native Agenda cover, and the Schedule
// surface's bounded forward window actually widening the read. Day reads ONE
// day and Schedule reads 120 (AgendaHome.tsx's `range`), so a surface switch
// that changed the chrome without changing the read would show the same rows —
// which is why the two seeded events asserted below are chosen to sit OUTSIDE
// today.
//
// Three claims, in order:
//   1. THE DAY SURFACE IS THE ARRIVAL: its two header actions are published by
//      the Agenda home alone, so neither can pass on Home or on a tab label.
//   2. THE SCHEDULE WINDOW READS THE REPLICA: today's errand and the dinner two
//      days out both appear, each by the `<summary>, <time>` accessible name
//      the event card publishes.
//   3. A CARD OPENS THE EVENT, and the event screen carries the vault's own
//      description plus its two acts — one of which asks rather than deletes.
//
// Every assertion is on copy or an accessibilityLabel only the asserted screen
// publishes (issue #483's non-vacuous rules; this file is listed in
// scripts/lint-e2e-flows.mjs).

import { retryableTapCommands } from "../lib/first-run.mjs";
import { FIRST_LAUNCH_TIMEOUT_MS, runFlow } from "../lib/harness.mjs";

await runFlow("agenda-week", async (ctx) => {
  await ctx.ensureDemo("agenda");
  await ctx.configureGateway({ fillSampleContent: true });
  await ctx.run(
    `appId: ${ctx.state.appId}
---
${retryableTapCommands("Open Agenda.*")}
# The Agenda home header's own two actions. "Agenda" itself is a tab/route name
# and is deliberately not asserted (scripts/lint-e2e-flows.mjs enforces that).
- extendedWaitUntil:
    visible: "Go to today"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- assertVisible: "New event"
- takeScreenshot: agenda-day
# A band tab stays on screen after it is tapped, so the conditional-retry
# helper would never stop retrying. Maestro's own retryTapIfNoChange plus the
# destination assertion below is the right instrument for a surface switch.
- tapOn:
    text: "^Schedule$"
    retryTapIfNoChange: true
# Both seeded summaries, through the card's "<summary>, <time>" accessible
# name. Today's errand is the first day row; the dinner sits two days down the
# list, so it is scrolled to rather than assumed on screen (the list is
# virtualized — an off-screen row is not mounted at all). Assert the errand
# BEFORE scrolling past it.
- extendedWaitUntil:
    visible: ".*Pick up the dry cleaning.*"
    timeout: 30000
- scrollUntilVisible:
    element:
      text: ".*Dinner with Maya.*"
    direction: DOWN
- assertVisible: ".*Dinner with Maya.*"
- takeScreenshot: agenda-schedule
`,
    "day-and-schedule"
  );
  await ctx.run(
    `appId: ${ctx.state.appId}
---
${retryableTapCommands(".*Dinner with Maya.*", "Go to today")}
# Only the pushed event screen draws this back control.
- extendedWaitUntil:
    visible: "Back to the agenda"
    timeout: 30000
# The seeded description, rendered as one single-line text node.
- assertVisible: ".*near the park.*"
- assertVisible: "Edit this event"
- assertVisible: "Ask to cancel this event"
- takeScreenshot: agenda-event
`,
    "event-screen"
  );
  return {
    pass: true,
    notes:
      "seeded week filled the Schedule window and an opened card carried the vault's description and its two acts",
  };
});
