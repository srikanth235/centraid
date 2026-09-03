import { retryableTapCommands } from "../lib/first-run.mjs";
import {
  AWAIT_LAUNCHER,
  FIRST_LAUNCH_TIMEOUT_MS,
  runFlow,
} from "../lib/harness.mjs";

await runFlow("people-roster", async (ctx) => {
  await ctx.ensureDemo("people");
  await ctx.configureGateway();
  await ctx.run(
    `appId: ${ctx.state.appId}
---
${AWAIT_LAUNCHER}${retryableTapCommands("Open People.*")}
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
