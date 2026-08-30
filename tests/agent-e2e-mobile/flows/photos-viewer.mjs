import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { retryableTapCommands } from "../lib/first-run.mjs";
import { FIRST_LAUNCH_TIMEOUT_MS, runFlow } from "../lib/harness.mjs";

await runFlow("photos-viewer", async (ctx) => {
  await ctx.ensureDemo("photos");
  await ctx.configureGateway({ fillSampleContent: true });
  await ctx.run(
    `appId: ${ctx.state.appId}
---
${retryableTapCommands("Open Photos.*")}
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
# The info sheet phrases the location (#816): a place with no member name and
# no gazetteer name reads as the honest fallback, never a coordinate, and the
# only digits live behind the explicit copy action.
- tapOn: "Info"
- extendedWaitUntil:
    visible: "Copy exact location"
    timeout: 15000
- assertVisible: "A place with no name yet"
- takeScreenshot: place-phrase-info
- tapOn: "Close photo information"
- tapOn: "Back to the photographs"
- extendedWaitUntil:
    visible: "Select"
    timeout: 15000
- takeScreenshot: photos-viewer-returned
`,
    "viewer-roundtrip"
  );

  // UI-impact evidence for #816 (check:ui-receipt): the phrase-first info
  // sheet, published where the desktop journeys publish theirs.
  const uiImpactDir = "artifacts/e2e/ui-impact";
  const screenshot = async () => {
    const frames = await readdir(ctx.state.screenshotsDir);
    const infoFrame = frames.find((frame) =>
      frame.endsWith("-place-phrase-info.png")
    );
    if (infoFrame === undefined)
      throw new Error("place-phrase-info frame was not captured");
    await mkdir(uiImpactDir, { recursive: true });
    await copyFile(
      path.join(ctx.state.screenshotsDir, infoFrame),
      path.join(uiImpactDir, "issue-816-place-phrase-info.png")
    );
  };
  await screenshot();

  return {
    pass: true,
    notes:
      "viewer opened, paged both directions, exposed capability rows, phrased the location on the info sheet, and dismissed",
  };
});
