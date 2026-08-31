// The People seat on the phone (home-journey roster, issue #864 — the
// `people.origin` cell).
//
// What only a device can falsify here: the CADENCE ARITHMETIC reaching the
// screen. People keeps no cadence on the row it draws — `cadence_days` lives on
// `people_profile`, the last contact lives on a `core.activity` linked to the
// party, and the sentence a member reads is `cadenceLineLabel()` joining the
// two. The phone reassembles that join itself: `usePeople` runs TEN separate
// replica queries and `projectRoster` / `projectPerson` stitch them, so a
// projection that dropped the profile join still draws every seeded name — with
// `No cadence` under it — and every fixture that hands the view a pre-merged
// person is green on both.
//
// Three claims, in order:
//   1. THE ROW IS THE VAULT'S PERSON, by the row's own accessible name:
//      `LABELS.openPerson(name)` is published by a People row and nothing else.
//      All four seeded people are asserted, not one — a roster that carried the
//      first row of a query and stopped is exactly what a broken window looks
//      like.
//   2. THE SECOND LINE IS THE PROFILE'S ROLE, per row. `rosterSub()` returns
//      the role alone for a person the sharing plane reports no binding for,
//      and two different roles are asserted so a single hard-coded sub-line
//      cannot pass.
//   3. THE CADENCE LINE IS THE JOIN. Opening a row prints
//      `Every 7 days · last …` — the seeded 7-day cadence from the profile,
//      beside the touch the seed logged. The DIGIT is the assertion: lose the
//      profile join and the same screen reads `No cadence · last …`.
//
// TIME-INDEPENDENT ON PURPOSE. `ctx.ensureDemo` seeds only when the scenario is
// absent, so on a long-lived gateway this corpus can be days old — and People's
// seed stamps every cadence and every contact at seeding time (it takes no
// `input.now`, unlike the Tasks seed). Nothing here may therefore assert that a
// seeded person IS or IS NOT overdue: that flips with the age of the vault. The
// `last …` half of the cadence line is left open for the same reason.
//
// Every assertion is on copy or an accessibilityLabel only the asserted screen
// publishes (issue #483's non-vacuous rules; this file is listed in
// scripts/lint-e2e-flows.mjs).

import { retryableTapCommands } from "../lib/first-run.mjs";
import { FIRST_LAUNCH_TIMEOUT_MS, runFlow } from "../lib/harness.mjs";

await runFlow("people-roster", async (ctx) => {
  await ctx.ensureDemo("people");
  await ctx.configureGateway();
  await ctx.run(
    `appId: ${ctx.state.appId}
---
${retryableTapCommands("Open People.*")}
# THE ROSTER DREW A ROW AT ALL, by the leading row's handle — the arrival
# marker. The roster's header word is the app's name and is drawn by the
# launcher tile too, so it could not tell an arrival from a tap that did
# nothing; people-row-first can only exist where People drew a list.
- extendedWaitUntil:
    visible:
      id: "people-row-first"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
# …and each row is the VAULT'S person, by the accessible name LABELS.openPerson
# builds. All four are asserted, not one — a roster that carried the first row
# of a query and stopped is exactly what a broken window looks like, and it is
# the shape a handle on the leading row alone would miss.
- assertVisible: "Open Grandpa Ray"
- assertVisible: "Open Maya Alvarez"
- assertVisible: "Open Jake Bennett"
- assertVisible: "Open Chris Okafor"
# Two different second lines, from two different profiles.
- assertVisible: "Grandfather"
- assertVisible: "Old roommate from Portland"
- takeScreenshot: people-roster
`,
    "roster"
  );
  await ctx.run(
    `appId: ${ctx.state.appId}
---
# Jake's row is the source marker: he is on the roster and NOT on the person
# screen, so the conditional retry stops the moment the push lands.
${retryableTapCommands("Open Grandpa Ray", "Open Jake Bennett")}
# The join, as one sentence. "Every 7 days" is the seeded profile cadence; the
# "last …" half is left open because the age of the seeded touch depends on how
# old this demo vault is.
- extendedWaitUntil:
    visible: "Every 7 days · last .*"
    timeout: 30000
- assertVisible: "Grandfather"
- takeScreenshot: people-cadence
`,
    "person-cadence"
  );
  return {
    pass: true,
    notes:
      "seeded circle drew all four rows with their own roles, and the person screen carried the profile cadence joined to the logged touch",
  };
});
