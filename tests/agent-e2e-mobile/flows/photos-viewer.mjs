import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { retryableTapCommands } from "../lib/first-run.mjs";
import {
  AWAIT_LAUNCHER,
  FIRST_LAUNCH_TIMEOUT_MS,
  runFlow,
} from "../lib/harness.mjs";

await runFlow("photos-viewer", async (ctx) => {
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
# its label. A band tab stays on screen after it is tapped, so Maestro's own
# retryTapIfNoChange plus the destination assertion is the right instrument.
- tapOn:
    id: "photos-band-library"
    retryTapIfNoChange: true
- extendedWaitUntil:
    visible:
      id: "photos-grid"
    timeout: 30000
- assertVisible:
    id: "photos-select"
# The photograph is opened by ITS OWN NAME, not by a positional handle. The
# journey's two strongest claims below depend on WHICH photograph this is: the
# disabled Previous photograph needs the first of the timeline, and the info
# sheet's phrasing needs the one whose place the vault has no name for. A tile
# handle would open whatever happens to lead the grid and turn both into
# assertions about the seed instead of about the viewer.
- tapOn:
    text: ".*Last light in the backyard.*|.*backyard-last-light.*"
- extendedWaitUntil:
    visible:
      id: "photos-viewer"
    timeout: 20000
- assertVisible: "Back to the photographs"
# THE FIRST PHOTOGRAPH HAS NO PREVIOUS ONE. The control is drawn and inert —
# never hidden — so its disabled state IS the assertion (refusal grammar).
- assertVisible:
    id: "photos-viewer-prev"
    enabled: false
# Paged FROM the pager rather than across the screen: the gesture now names the
# element it is dragging, so a layout change moves the anchor with it.
- swipe:
    from:
      id: "photos-viewer-pager"
    direction: LEFT
    duration: 400
- extendedWaitUntil:
    visible:
      id: "photos-viewer-prev"
      enabled: true
    timeout: 10000
- swipe:
    from:
      id: "photos-viewer-pager"
    direction: RIGHT
    duration: 400
- extendedWaitUntil:
    visible:
      id: "photos-viewer-prev"
      enabled: false
    timeout: 10000
- tapOn:
    id: "photos-viewer-more"
# The menu's rows ARE the seat's capabilities, stated in the member's words —
# copy, and asserted as copy.
- assertVisible: "Hide"
- assertVisible: "Slideshow"
- assertVisible: "Add to Album"
- assertVisible: "Adjust Location"
- assertVisible: "Download"
- assertVisible: "Send a copy"
- assertVisible: "Delete"
# The transparent backdrop is intentionally outside the modal's accessibility
# subtree, which is why this used to be a 10%,50% point tap. The handle reaches
# it directly and dismisses only that backdrop.
- tapOn:
    id: "shell-menu-backdrop"
- extendedWaitUntil:
    notVisible:
      id: "shell-menu-card"
    timeout: 10000
# The info sheet phrases the location (#816): a place with no member name and
# no gazetteer name reads as the honest fallback, never a coordinate, and the
# only digits live behind the explicit copy action.
- tapOn:
    id: "photos-viewer-action-info"
- extendedWaitUntil:
    visible:
      id: "photos-info-sheet"
    timeout: 15000
- assertVisible: "Copy exact location"
- assertVisible: "A place with no name yet"
- takeScreenshot: place-phrase-info
- tapOn:
    id: "photos-info-close"
- tapOn:
    id: "photos-viewer-back"
- extendedWaitUntil:
    visible:
      id: "photos-grid"
    timeout: 15000
- takeScreenshot: photos-viewer-returned
`,
    "viewer-roundtrip"
  );

  const uiImpactDir = "artifacts/e2e/ui-impact";
  const screenshot = async () => {
    const frames = await readdir(ctx.state.screenshotsDir);
    const infoFrame = frames.find((frame) => frame === "place-phrase-info.png");
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
      "viewer opened, paged both directions from its own pager, exposed capability rows, phrased the location on the info sheet, and dismissed",
  };
});
