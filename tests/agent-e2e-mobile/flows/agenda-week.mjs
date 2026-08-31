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
// Four claims, in order:
//   1. THE DAY SURFACE IS THE ARRIVAL: its two header actions are published by
//      the Agenda home alone, so neither can pass on Home or on a tab label.
//   2. THE COMPOSER WRITES (#890 W5): `New event` was asserted here for its
//      whole life and never pressed. It is pressed now, and the event a member
//      typed has to come back out of the SAME widened read the seeded corpus
//      does — an event the composer accepted but the replica never took would
//      leave the composer looking perfectly healthy.
//   3. THE SCHEDULE WINDOW READS THE REPLICA: today's errand and the dinner two
//      days out both appear, each by the `<summary>, <time>` accessible name
//      the event card publishes.
//   4. A CARD OPENS THE EVENT, and the event screen carries the vault's own
//      description plus its two acts — one of which asks rather than deletes.
//
// SELECTOR RULE (#890 W2): CHROME is found by handle (`agenda-today`,
// `agenda-new-event`, `agenda-band-<key>`, `agenda-event-back`), CONTENT by its
// own words — a seeded summary and a typed summary are the vault's strings, and
// finding a card by the text it should carry IS the assertion.
//
// Every assertion is on copy or an accessibilityLabel only the asserted screen
// publishes (issue #483's non-vacuous rules; this file is discovered by
// scripts/lint-e2e-flows.mjs).

import {
  openHomeAppCommands,
  retryableTapCommands,
} from "../lib/first-run.mjs";
import { FIRST_LAUNCH_TIMEOUT_MS, runFlow } from "../lib/harness.mjs";

await runFlow("agenda-week", async (ctx) => {
  await ctx.ensureDemo("agenda");
  await ctx.configureGateway();

  // Unique per RUN: `ensureDemo` seeds only when the scenario is absent, so on
  // a long-lived gateway an event left behind by an earlier run would satisfy
  // the assertion below without this run writing anything at all.
  const composedEvent = `Composed on device ${ctx.state.runId}`;

  await ctx.run(
    `appId: ${ctx.state.appId}
---
${openHomeAppCommands("agenda", "Open Agenda.*")}
# The Agenda home header's own two actions, by their handles. "Agenda" itself is
# a tab/route name and is deliberately not asserted (scripts/lint-e2e-flows.mjs
# enforces that); the labels are kept beside the handles because they are what a
# member hears, and a handle on an unlabelled control would hide that loss.
- extendedWaitUntil:
    visible:
      id: "agenda-today"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- assertVisible: "Go to today"
- assertVisible:
    id: "agenda-new-event"
- assertVisible: "New event"
- takeScreenshot: agenda-day
`,
    "day-surface"
  );

  // ─── The write (#890 W5) ──────────────────────────────────────────────────
  // ~30 s of marginal work on a journey that has already paid the boot, the
  // pairing and the seed. The composer opens on a start time rounded to the
  // next half hour of TODAY (AgendaCreateModal.tsx), so the event it creates is
  // inside both the Day read and the Schedule window — nothing here has to
  // guess a date.
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- tapOn:
    id: "agenda-new-event"
- extendedWaitUntil:
    visible: "Save this event"
    timeout: 30000
# The composer's Title field AUTOFOCUSES and carries neither a handle nor a
# placeholder, so there is nothing to tap and nothing to name — the keystrokes
# go to it because it already holds focus. That absent handle is the one gap
# this journey still has; it is reported rather than invented here, since an id
# no screen renders fails lint:mobile-testids the moment it is written.
- inputText: "${composedEvent}"
# Asserted AT the field, where a swallowed keystroke actually happens: the field
# is a single-line TextInput whose whole node text is the value, which is the
# case Maestro's matcher handles (same instrument as the Tally composer in
# native-v0-resilience.mjs).
- assertVisible: "${composedEvent}"
- hideKeyboard
- tapOn: "Save this event"
# The composer closes ONLY on a successful create (AgendaCreateModal's submit
# calls onClose behind if (created)), so the sheet going away is the write
# being accepted. It is NOT the write being readable, which is what the
# Schedule chunk below is for.
#
# The card is deliberately NOT asserted here. The composer starts at the next
# half hour, which rolls into TOMORROW between 23:30 and midnight — a Day
# surface that reads one day would then be honestly empty of it, and a flow that
# fails for half an hour a night is a flow people learn to re-run. The Schedule
# window reads 120 days and holds it whichever side of midnight it landed.
- extendedWaitUntil:
    notVisible: "Save this event"
    timeout: 30000
- takeScreenshot: agenda-composed
`,
    "compose-an-event"
  );

  await ctx.run(
    `appId: ${ctx.state.appId}
---
# A band tab stays on screen after it is tapped, so the conditional-retry
# helper would never stop retrying. Maestro's own retryTapIfNoChange plus the
# destination assertion below is the right instrument for a surface switch. The
# destination is taken by its KEY — the band model already keys on it, while
# "Schedule" is a label the copy may re-word.
- tapOn:
    id: "agenda-band-schedule"
    retryTapIfNoChange: true
# Both seeded summaries, through the card's "<summary>, <time>" accessible
# name. Today's errand is the first day row; the dinner sits two days down the
# list, so it is scrolled to rather than assumed on screen (the list is
# virtualized — an off-screen row is not mounted at all). Assert the errand
# BEFORE scrolling past it.
- extendedWaitUntil:
    visible: ".*Pick up the dry cleaning.*"
    timeout: 30000
# …and THIS RUN'S OWN EVENT in the same widened read. It is scrolled to rather
# than assumed on screen for the same reason the dinner is: the list is
# virtualized, and where the event sorted depends on the hour the flow ran.
- scrollUntilVisible:
    element:
      text: ".*${composedEvent}.*"
    direction: DOWN
- assertVisible: ".*${composedEvent}.*"
- scrollUntilVisible:
    element:
      text: ".*Dinner with Maya.*"
    direction: DOWN
- assertVisible: ".*Dinner with Maya.*"
- takeScreenshot: agenda-schedule
`,
    "schedule-window"
  );
  await ctx.run(
    `appId: ${ctx.state.appId}
---
${retryableTapCommands(".*Dinner with Maya.*", "Go to today")}
# Only the pushed event screen draws this back control, and it is taken by its
# handle so a re-worded label cannot read as a missing screen.
- extendedWaitUntil:
    visible:
      id: "agenda-event-back"
    timeout: 30000
- assertVisible: "Back to the agenda"
# The seeded description, rendered as one single-line text node.
- assertVisible: ".*near the park.*"
- assertVisible: "Edit this event"
- assertVisible: "Ask to cancel this event"
- takeScreenshot: agenda-event
`,
    "event-screen"
  );
  ctx.note(
    `an event composed on device appeared in the Schedule window: "${composedEvent}"`
  );
  return {
    pass: true,
    notes:
      "seeded week filled the Schedule window, an event composed on device joined it, and an opened card carried the vault's description and its two acts",
  };
});
