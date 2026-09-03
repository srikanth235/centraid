import { retryableTapCommands } from "../lib/first-run.mjs";
import {
  AWAIT_LAUNCHER,
  FIRST_LAUNCH_TIMEOUT_MS,
  runFlow,
} from "../lib/harness.mjs";

await runFlow("places-seat", async (ctx) => {
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
# The Places section sits below Memories/Albums/People on the Collections page.
# Its heading is taken by the shelf's OWN KEY, not by "Open Places, N": that
# label carries the vault's count, so it is a locator that changes every seed —
# PhotosCollectionsView.tsx says exactly that at the handle.
- scrollUntilVisible:
    element:
      id: "photos-shelf-places"
    direction: DOWN
    visibilityPercentage: 100
- tapOn:
    id: "photos-shelf-places"
    retryTapIfNoChange: true
# The shelf's own header — "Places · N" is published by PlacesView alone, and
# a seeded vault must count at least one place. A zero here is the #787
# defect shape (map full, shelf empty), so the digit is the assertion; the
# handle beside it is what proves the header was drawn at all.
- extendedWaitUntil:
    visible:
      id: "places-shelf"
    timeout: 30000
- assertVisible: "Places · [1-9][0-9]*"
# At least one card — the leading one by position, and the label every card
# publishes. The label is the claim (a place, and how many photographs of it);
# the handle is how the flow knows a card was drawn rather than a rail of
# skeletons.
- assertVisible:
    id: "places-card-0"
- assertVisible: ".*, [0-9]+ photographs"
- takeScreenshot: places-shelf
- tapOn:
    id: "places-map-open"
    retryTapIfNoChange: true
# The map's resting sentence — the privacy claim the screen makes about
# itself — plus its own "drawn of held" count, both map-only copy.
- extendedWaitUntil:
    visible:
      id: "places-map"
    timeout: 30000
- assertVisible: "Plotted from your own photographs."
- assertVisible: "[1-9][0-9]* of [1-9][0-9]*"
# Press a pin — by position, since which place leads the plotted set is the
# vault's business — and the readout replaces the resting sentence with
# "<where> · N". BOTH halves are asserted, because a readout that appeared
# BESIDE the resting sentence would be a different product than one that
# replaced it.
- tapOn:
    id: "places-pin-0"
- extendedWaitUntil:
    visible: ".* · [0-9]+"
    timeout: 15000
- assertVisible:
    id: "places-readout"
- assertNotVisible: "Plotted from your own photographs."
- takeScreenshot: places-map-readout
`,
    "places-shelf-and-map"
  );
  return {
    pass: true,
    notes:
      "seeded geo_lat/geo_lng rows carded the shelf, drew the map, and a pressed pin read out",
  };
});
