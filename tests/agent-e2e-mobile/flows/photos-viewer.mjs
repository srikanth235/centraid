import { PHOTOS_HOME_ENTRY, retryableTapCommands } from "../lib/first-run.mjs";
import { FIRST_LAUNCH_TIMEOUT_MS, runFlow } from "../lib/harness.mjs";

await runFlow("photos-viewer", async (ctx) => {
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
- tapOn:
    text: ".*Last light in the backyard.*|.*backyard-last-light.*"
- extendedWaitUntil:
    visible: "Back to the photographs"
    timeout: 20000
- assertVisible:
    text: "Previous photograph"
    enabled: false
- swipe:
    start: "80%,30%"
    end: "20%,30%"
    duration: 400
- extendedWaitUntil:
    visible:
      text: "Previous photograph"
      enabled: true
    timeout: 10000
- swipe:
    start: "20%,30%"
    end: "80%,30%"
    duration: 400
- extendedWaitUntil:
    visible:
      text: "Previous photograph"
      enabled: false
    timeout: 10000
- tapOn: "More actions"
- assertVisible: "Hide"
- assertVisible: "Slideshow"
- assertVisible: "Add to Album"
- assertVisible: "Adjust Location"
- assertVisible: "Download"
- assertVisible: "Send a copy"
- assertVisible: "Delete"
# The transparent menu backdrop is intentionally hidden from the modal's
# accessibility subtree. This stable left-stage point is outside its anchored
# card on every supported phone width and dismisses only that backdrop.
- tapOn:
    point: "10%,50%"
- tapOn: "Back to the photographs"
- extendedWaitUntil:
    visible: "Select"
    timeout: 15000
- takeScreenshot: photos-viewer-returned
`,
    "viewer-roundtrip"
  );
  return {
    pass: true,
    notes:
      "viewer opened, paged both directions, exposed capability rows, and dismissed",
  };
});
