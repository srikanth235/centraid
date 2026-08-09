import {
  DISMISS_OPEN_LINK_CONFIRMATION,
  retryableTapCommands,
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
- extendedWaitUntil:
    visible: "Home ready"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- openLink: "centraid://photos"
${DISMISS_OPEN_LINK_CONFIRMATION}- waitForAnimationToEnd:
    timeout: 1000
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
