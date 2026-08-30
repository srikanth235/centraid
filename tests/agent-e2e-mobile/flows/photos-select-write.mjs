import { retryableTapCommands } from "../lib/first-run.mjs";
import { SCREEN_TRANSITION_TIMEOUT_MS, runFlow } from "../lib/harness.mjs";

await runFlow("photos-select-write", async (ctx) => {
  await ctx.ensureDemo("photos");
  await ctx.configureGateway({ fillSampleContent: true });
  await ctx.run(
    `appId: ${ctx.state.appId}
---
${retryableTapCommands("Open Photos.*")}
- extendedWaitUntil:
    visible: "Collections"
    timeout: ${SCREEN_TRANSITION_TIMEOUT_MS}
${retryableTapCommands("Library")}
- extendedWaitUntil:
    visible: "Select"
    timeout: 30000
- tapOn: "Select"
- tapOn: "Select .*"
- assertVisible: "2 Photos Selected"
- tapOn: "Move to trash"
- assertVisible: "Move 2 to trash[?]"
- tapOn: "Trash"
- extendedWaitUntil:
    notVisible: "2 Photos Selected"
    timeout: 20000
${retryableTapCommands("Collections")}
- scrollUntilVisible:
    element:
      text: "Open Trash.*"
    direction: DOWN
    timeout: 20000
- tapOn:
    text: "Open Trash.*"
    retryTapIfNoChange: true
- extendedWaitUntil:
    visible: "Deleted photographs stay here for 30 days.*"
    timeout: 20000
- tapOn: "Select"
- tapOn: "Select .*"
- assertVisible: "Restore"
- tapOn: "Restore"
- extendedWaitUntil:
    visible: "Trash is empty[.]"
    timeout: ${SCREEN_TRANSITION_TIMEOUT_MS}
- takeScreenshot: photos-write-restored
${retryableTapCommands("Collections")}
${retryableTapCommands("Library")}
- extendedWaitUntil:
    visible: "Open album Tahoe scouting, 4 photos"
    timeout: ${SCREEN_TRANSITION_TIMEOUT_MS}
`,
    "select-trash-restore"
  );
  return {
    pass: true,
    notes:
      "two-photo selection, confirmed trash write, disappearance, and restore passed",
  };
});
