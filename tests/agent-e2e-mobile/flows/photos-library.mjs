import { retryableTapCommands } from "../lib/first-run.mjs";
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
${retryableTapCommands("Open Photos.*")}
- extendedWaitUntil:
    visible:
      id: "photos-collections"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- assertVisible: "Collections"
# The band destination by its KEY (photos-band.ts already keys on it), never
# its label. A band tab stays on screen after it is tapped, so Maestro's own
# retryTapIfNoChange plus the destination assertion is the right instrument,
# not the conditional-retry helper (which would never stop retrying).
- tapOn:
    id: "photos-band-library"
    retryTapIfNoChange: true
- extendedWaitUntil:
    visible:
      id: "photos-grid"
    timeout: 30000
- assertVisible:
    id: "photos-select"
- assertVisible: "${currentMonth}"
- assertVisible: ".*(Sun|Mon|Tue|Wed|Thu|Fri|Sat),.*"
- scroll
# THE GRAIN DRAWER HAS NO HANDLES. "Months" / "All" are the scroll-owned grain
# controls (TimelineGrain), and nothing in kit/test-ids.ts names them — so these
# three steps stay on copy deliberately rather than on an invented id, which
# scripts/lint-mobile-testids.mjs would refuse the moment it was written. Noted
# as a gap under #890 W2.
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
