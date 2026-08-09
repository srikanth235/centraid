import {
  PHOTOS_HOME_ENTRY,
  relaunchDevClientCommands,
  retryableTapCommands,
  waitForHomeReadyCommands,
} from "../lib/first-run.mjs";
import { FIRST_LAUNCH_TIMEOUT_MS, runFlow } from "../lib/harness.mjs";

await runFlow("photos-permissions", async (ctx) => {
  // This journey owns the suite's fresh pairing slot. Purging first proves the
  // literal empty-vault takeover; the next journey reseeds the same gateway
  // and the paired replica receives that corpus through normal sync.
  await ctx.purgeDemo("photos");
  await ctx.configureGateway();
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- launchApp:
    clearState: false
    permissions:
      all: deny
${relaunchDevClientCommands(ctx.state.platform)}${waitForHomeReadyCommands(FIRST_LAUNCH_TIMEOUT_MS, ctx.state.platform)}
${retryableTapCommands(PHOTOS_HOME_ENTRY)}
- extendedWaitUntil:
    visible: "Collections"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
${retryableTapCommands("Library")}
- extendedWaitUntil:
    visible: "Photos cannot reach your camera roll"
    timeout: 20000
- assertVisible: "Allow access|Open Settings"
- assertVisible:
    text: "Select"
    enabled: false
- assertVisible: "Home"
- takeScreenshot: photos-permission-takeover
`,
    "permission-refused"
  );
  return {
    pass: true,
    notes:
      "refused device permission took over an empty vault library with recovery and a way home",
  };
});
