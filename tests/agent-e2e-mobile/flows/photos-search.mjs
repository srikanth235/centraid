import { retryableTapCommands } from "../lib/first-run.mjs";
import { FIRST_LAUNCH_TIMEOUT_MS, runFlow } from "../lib/harness.mjs";

await runFlow("photos-search", async (ctx) => {
  await ctx.ensureDemo("photos");
  await ctx.configureGateway();
  await ctx.run(
    `appId: ${ctx.state.appId}
---
${retryableTapCommands("Open Photos.*")}
- extendedWaitUntil:
    visible: "Collections"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
${retryableTapCommands("Search")}
- tapOn: "Search photographs"
# e2e-lint-allow: input-observed — Results and the seeded album row below are
# the end-to-end observation of this exact deterministic query.
- inputText: "Tahoe scouting"
- hideKeyboard
- extendedWaitUntil:
    visible: "Results"
    timeout: 30000
- assertVisible: "[1-9][0-9]* results.*"
- assertVisible: "Open Tahoe scouting.*"
${retryableTapCommands("Open Tahoe scouting.*")}
- extendedWaitUntil:
    visible: ".*Tahoe scouting.*"
    timeout: 15000
- tapOn:
    text: ".*Emerald Bay overlook.*|.*emerald-bay-overlook.*"
- extendedWaitUntil:
    visible: "Back to the photographs"
    timeout: 15000
- takeScreenshot: photos-search-viewer
`,
    "search-album-viewer"
  );
  return {
    pass: true,
    notes:
      "seeded album query produced grouped and photo results and opened the viewer",
  };
});
