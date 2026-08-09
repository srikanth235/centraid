import { PHOTOS_HOME_ENTRY, retryableTapCommands } from "../lib/first-run.mjs";
import { FIRST_LAUNCH_TIMEOUT_MS, runFlow } from "../lib/harness.mjs";

const now = new Date();
const currentYear = String(now.getFullYear());
const currentMonth = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
}).format(now);

await runFlow("photos-library", async (ctx) => {
  await ctx.ensureDemo("photos");
  await ctx.configureGateway();
  await ctx.run(
    `appId: ${ctx.state.appId}
---
${retryableTapCommands(PHOTOS_HOME_ENTRY)}
- extendedWaitUntil:
    visible: "Collections"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
${retryableTapCommands("Library")}
- extendedWaitUntil:
    visible: "Select"
    timeout: 30000
- assertVisible: "${currentMonth}"
- assertVisible: ".*(Sun|Mon|Tue|Wed|Thu|Fri|Sat),.*"
- scroll
- assertVisible: "Months"
- tapOn: "Months"
- extendedWaitUntil:
    visible: "${currentYear}"
    timeout: 15000
- tapOn:
    text: "${currentMonth}.*"
- assertVisible: "All"
- extendedWaitUntil:
    notVisible: "All"
    timeout: 7000
- takeScreenshot: photos-library-drilldown
`,
    "library-drilldown"
  );
  return {
    pass: true,
    notes:
      "library headers, scroll-owned drawer, Months drill-down, and withdrawal passed",
  };
});
