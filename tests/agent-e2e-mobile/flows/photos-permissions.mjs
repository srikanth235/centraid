import { LAUNCHER_RECOVERY, retryableTapCommands } from "../lib/first-run.mjs";
import {
  CONFIRM_SYSTEM_OPEN,
  HOME_READY_MARKER,
  RELAUNCH_TIMEOUT_MS,
  SCREEN_TRANSITION_TIMEOUT_MS,
  runFlow,
} from "../lib/harness.mjs";

await runFlow("photos-permissions", async (ctx) => {
  // This isolated journey runs last and pairs from clean app state. Purging
  // proves the literal empty-vault takeover without letting denied OS
  // permission or a post-pair seed contaminate fixture-backed functionality.
  await ctx.purgeDemo("photos");
  await ctx.configureGateway();
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- launchApp:
    clearState: false
    permissions:
      all: deny
${LAUNCHER_RECOVERY}- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${RELAUNCH_TIMEOUT_MS}
- openLink: "centraid://photos"
${CONFIRM_SYSTEM_OPEN}- extendedWaitUntil:
    visible: "Collections"
    timeout: ${SCREEN_TRANSITION_TIMEOUT_MS}
${retryableTapCommands("Library")}
- extendedWaitUntil:
    visible: "Photos cannot reach your camera roll"
    timeout: 20000
- assertVisible: "Allow access|Open Settings"
- assertVisible:
    text: "Select"
    enabled: false
- takeScreenshot: photos-permission-takeover
# The way home is the one thing an app may never take away, and the refusal
# takeover is exactly where it would be lost. Asserting the capsule's label
# proved nothing: "Home" is also the frame's tab-bar label, so the assertion
# passed on every screen in the app whether the capsule rendered or not
# (route-name). Tap it and require Home to actually arrive — that is the
# claim this journey's verdict makes ("escapable through Home"), and only a
# real return can fail when the capsule is missing or wired to a no-op.
${retryableTapCommands("Home", "Photos cannot reach your camera roll")}
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: 30000
`,
    "permission-refused"
  );
  return {
    pass: true,
    notes:
      "refused device permission took over an empty vault library with recovery, and the way home returned to Home",
  };
});
