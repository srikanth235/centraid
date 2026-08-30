// The Places seat on the phone (issue #781; defect class #787).
//
// What only a device can falsify here: the seeded replica's REAL `core_place`
// rows (physical `geo_lat`/`geo_lng` columns, no web-handler rename) reaching
// all three Places surfaces. #787 was exactly this seam: the map drew pins
// while the shelf read "No places yet" because the shelf keyed on columns the
// vault never ships — a defect no unit or component fixture proved, because
// every fixture used the column names the code expected.
//
// Three claims, in order:
//   1. THE SHELF RENDERS FROM THE SEEDED VAULT: the Collections "Places" rail
//      opens a shelf whose own header counts a non-zero number of places and
//      whose cards each publish a "<name>, N photographs" label.
//   2. THE MAP DRAWS THE SAME DATA and rests on its privacy sentence — the
//      map fetches nothing, and says so.
//   3. A PIN READS OUT: pressing a pin replaces the resting sentence with
//      that place's readout, so the pins are real controls, not decoration.
//
// Every assertion is on copy or an accessibilityLabel only the asserted
// screen publishes (issue #483's non-vacuous rules; this file is listed in
// scripts/lint-e2e-flows.mjs).

import { settledRetryableTapCommands } from "../lib/first-run.mjs";
import { SCREEN_TRANSITION_TIMEOUT_MS, runFlow } from "../lib/harness.mjs";

await runFlow("places-seat", async (ctx) => {
  await ctx.ensureDemo("photos");
  await ctx.configureGateway({ fillSampleContent: true });
  await ctx.run(
    `appId: ${ctx.state.appId}
---
${settledRetryableTapCommands("Open Photos.*")}
- extendedWaitUntil:
    visible: "Collections"
    timeout: ${SCREEN_TRANSITION_TIMEOUT_MS}
# The Places section sits below Memories/Albums/People on the Collections
# page; its heading is the "Open Places, N" Pressable.
- scrollUntilVisible:
    element:
      text: "Open Places.*"
    direction: DOWN
${settledRetryableTapCommands("Open Places.*")}
# The shelf's own header — "Places · N" is published by PlacesView alone, and
# a seeded vault must count at least one place. A zero here is the #787
# defect shape (map full, shelf empty), so the digit is the assertion.
- extendedWaitUntil:
    visible: "Places · [1-9][0-9]*"
    timeout: 30000
# At least one card, by the label every card publishes.
- assertVisible: ".*, [0-9]+ photographs"
- takeScreenshot: places-shelf
${settledRetryableTapCommands("Open map")}
# The map's resting sentence — the privacy claim the screen makes about
# itself — plus its own "drawn of held" count, both map-only copy.
- extendedWaitUntil:
    visible: "Plotted from your own photographs."
    timeout: 30000
- assertVisible: "[1-9][0-9]* of [1-9][0-9]*"
# Press a pin on the real native ground. MapKit and MapLibre both publish the
# same accessible "<where>, N photographs" control over their native marker.
# The readout replaces the resting sentence with "<where> · N".
- tapOn:
    text: ".*, [0-9]+ photographs?"
- extendedWaitUntil:
    visible: ".* · [0-9]+"
    timeout: 15000
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
