import {
  openAppLinkCommands,
  retryableTapCommands,
} from "../lib/first-run.mjs";
import { FIRST_LAUNCH_TIMEOUT_MS, runFlow } from "../lib/harness.mjs";

await runFlow("photos-select-write", async (ctx) => {
  await ctx.ensureDemo("photos");
  await ctx.configureGateway();
  await ctx.run(
    `appId: ${ctx.state.appId}
---
${openAppLinkCommands("photos")}
- extendedWaitUntil:
    visible:
      id: "photos-collections"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- assertVisible: "Collections"
# Band destinations by their KEYS (photos-band.ts already keys on them), never
# their labels. A band tab stays on screen after it is tapped, so Maestro's own
# retryTapIfNoChange plus the destination assertion is the right instrument.
- tapOn:
    id: "photos-band-library"
    retryTapIfNoChange: true
- extendedWaitUntil:
    visible:
      id: "photos-grid"
    timeout: 30000
- tapOn:
    id: "photos-select"
# The second tile is still taken by the per-tile "Select <title>" label: the
# grid's positional handles stop at PHOTO_TILE_HANDLES and name TILES, while
# selection mode needs whichever two rows are on screen. The COUNT below is the
# claim either way.
- tapOn: "Select .*"
- assertVisible: "2 Photos Selected"
- tapOn:
    id: "photos-selection-trash"
- assertVisible: "Move 2 to trash[?]"
- tapOn: "Trash"
- extendedWaitUntil:
    notVisible: "2 Photos Selected"
    timeout: 20000
- tapOn:
    id: "photos-band-collections"
    retryTapIfNoChange: true
- scrollUntilVisible:
    element:
      id: "photos-shelf-trash"
    direction: DOWN
    visibilityPercentage: 100
    timeout: 20000
- tapOn:
    id: "photos-shelf-trash"
    retryTapIfNoChange: true
- extendedWaitUntil:
    visible: "Deleted photographs stay here for 30 days.*"
    timeout: 20000
# THE TRASH SHELF'S OWN SELECT CHIP HAS NO HANDLE. photos-select is scoped to
# PhotosHome's Library destination; Trash is a separate route (PhotoStateView)
# whose SelectChip carries none, so this tap stays on copy rather than on an id
# that would resolve to the wrong screen. Reported as a gap under #890 W2.
- tapOn: "Select"
- tapOn: "Select .*"
- assertVisible: "Restore"
- tapOn: "Restore"
- extendedWaitUntil:
    notVisible: "Photo Selected"
    timeout: 20000
- takeScreenshot: photos-write-restored
`,
    "select-trash-restore"
  );
  return {
    pass: true,
    notes:
      "two-photo selection, confirmed trash write, disappearance, and restore passed",
  };
});
