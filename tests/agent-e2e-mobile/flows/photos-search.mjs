import { retryableTapCommands } from "../lib/first-run.mjs";
import {
  AWAIT_LAUNCHER,
  FIRST_LAUNCH_TIMEOUT_MS,
  runFlow,
} from "../lib/harness.mjs";

await runFlow("photos-search", async (ctx) => {
  await ctx.ensureDemo("photos");
  await ctx.configureGateway();
  await ctx.run(
    `appId: ${ctx.state.appId}
---
${AWAIT_LAUNCHER}${retryableTapCommands("Open Photos.*")}
- extendedWaitUntil:
    visible:
      id: "photos-collections"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- assertVisible: "Collections"
# The band destination by its KEY (photos-band.ts already keys on it), never
# its label — "Search" is a word half the app draws. A band tab stays on screen
# after it is tapped, so Maestro's own retryTapIfNoChange plus the destination
# assertion is the right instrument, not the conditional-retry helper.
- tapOn:
    id: "photos-band-search"
    retryTapIfNoChange: true
- extendedWaitUntil:
    visible:
      id: "photos-search-field"
    timeout: 30000
- tapOn:
    id: "photos-search-field"
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
