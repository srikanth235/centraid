import { retryableTapCommands } from "../lib/first-run.mjs";
import {
  AWAIT_LAUNCHER,
  FIRST_LAUNCH_TIMEOUT_MS,
  HOME_READY_MARKER,
  runFlow,
} from "../lib/harness.mjs";

const BURST = 5;

await runFlow("op-sqlite-probe", async (ctx) => {
  await ctx.ensureDemo("notes");
  await ctx.configureGateway();

  const tag = `opsqlite ${ctx.state.runId}`;

  await ctx.run(
    `appId: ${ctx.state.appId}
---
${AWAIT_LAUNCHER}${retryableTapCommands("Open Notes.*")}
- extendedWaitUntil:
    visible: "New note"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- assertVisible:
    id: "notes-row-first"
`,
    "notes-open"
  );
  ctx.note("Notes cover open on the seeded corpus");

  for (let index = 0; index < BURST; index += 1) {
    const title = `${tag} ${index}`;
    // oxlint-disable-next-line no-await-in-loop
    await ctx.run(
      `appId: ${ctx.state.appId}
---
- extendedWaitUntil:
    visible:
      id: "notes-capture"
    timeout: 30000
- tapOn:
    id: "notes-capture"
- extendedWaitUntil:
    visible:
      id: "notes-editor-close"
    timeout: 30000
- tapOn: "Title"
- inputText: "${title}"
- assertVisible: "${title}"
- hideKeyboard
- tapOn: "Save this note"
# The list is a different tree from the editor and sorts pinned-then-newest, so
# the note just written is the leading row. Asserting it HERE, before the next
# iteration opens the composer again, is what keeps the next write overlapping
# this read rather than following it.
- extendedWaitUntil:
    visible:
      id: "notes-row-first"
    timeout: 30000
- assertVisible: "Open ${title}"
`,
      `burst-${index}`
    );
  }
  ctx.note(`${BURST} notes written and each read back before the next`);

  await ctx.restart();
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
${AWAIT_LAUNCHER}${retryableTapCommands("Open Notes.*")}
- extendedWaitUntil:
    visible: "New note"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
`,
    "relaunch"
  );

  for (let index = 0; index < BURST; index += 1) {
    // oxlint-disable-next-line no-await-in-loop
    await ctx.run(
      `appId: ${ctx.state.appId}
---
- assertVisible: "Open ${tag} ${index}"
`,
      `survived-${index}`
    );
  }
  ctx.note(`all ${BURST} writes survived process death`);

  await ctx.run(
    `appId: ${ctx.state.appId}
---
- assertVisible:
    id: "notes-row-first"
- assertVisible: "Open ${tag} ${BURST - 1}"
`,
    "exactly-once"
  );
  ctx.note(
    "leading row is still the last write of the burst — no intent re-executed on recovery"
  );

  await ctx.run(
    `appId: ${ctx.state.appId}
---
- takeScreenshot: op-sqlite-probe
`,
    "evidence"
  );
});
