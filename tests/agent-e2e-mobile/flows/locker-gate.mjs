import { retryableTapCommands } from "../lib/first-run.mjs";
import {
  AWAIT_LAUNCHER,
  FIRST_LAUNCH_TIMEOUT_MS,
  HOME_READY_MARKER,
  runFlow,
} from "../lib/harness.mjs";

const GATE_ASSERTIONS = `- assertVisible:
    id: "locker-gate"
- assertVisible: "Twelve characters at least, the only way in that cannot be revoked.*"
- assertVisible:
    id: "locker-gate-submit"
    enabled: false
- assertVisible:
    text: "Create it"
    enabled: false`;

await runFlow("locker-gate", async (ctx) => {
  await ctx.ensureDemo("docs");
  await ctx.configureGateway();
  await ctx.run(
    `appId: ${ctx.state.appId}
---
# The withheld count, spoken. "Open Locker, 0 locked" would mean Home had begun
# reading the one app it must not. The tile's handle is asserted first so the
# sentence cannot pass on a Home that drew no Locker tile at all — the label is
# the claim, the handle is what proves there is something carrying it.
${AWAIT_LAUNCHER}
- assertVisible:
    id: "home-tile-locker"
- assertVisible: "Open Locker, locked"
${retryableTapCommands("Open Locker.*")}
- extendedWaitUntil:
    visible: "Choose a passphrase"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- assertVisible: "Nothing is browsable until there is a passphrase"
${GATE_ASSERTIONS}
- takeScreenshot: locker-gate
`,
    "sealed-on-arrival"
  );

  await ctx.restart();

  await ctx.run(
    `appId: ${ctx.state.appId}
---
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
${AWAIT_LAUNCHER}${retryableTapCommands("Open Locker.*")}
- extendedWaitUntil:
    visible: "Choose a passphrase"
    timeout: 30000
${GATE_ASSERTIONS}
- takeScreenshot: locker-gate-after-restart
`,
    "sealed-after-restart"
  );
  ctx.note(
    "Home never published a Locker count; the cover opened on its gate before and after an OS process restart"
  );
  return {
    pass: true,
    notes:
      "Locker stayed sealed: withheld count on Home, refusing first-run gate, unchanged across a process restart",
  };
});
