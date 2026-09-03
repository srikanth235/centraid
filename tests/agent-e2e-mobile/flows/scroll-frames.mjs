import { promises as fs } from "node:fs";
import path from "node:path";

import {
  recordQualityResult,
  rigDriftBudget,
} from "../../agent-e2e-shared/harness.mjs";
import { readFrameEvidence } from "../lib/frame-report.mjs";
import {
  AWAIT_LAUNCHER,
  CONFIRM_SYSTEM_OPEN,
  FIRST_LAUNCH_TIMEOUT_MS,
  runFlow,
} from "../lib/harness.mjs";

const OWNER = "tests/agent-e2e-mobile/flows/scroll-frames.mjs";
const FLINGS = 8;
const SAMPLE_WINDOW_MS = 6_000;
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

const PHOTOS_MARKER = "photos-tile-0";

function flingYaml(appId, marker, markerKind, surface) {
  const settle =
    markerKind === "id"
      ? `- extendedWaitUntil:
    visible:
      id: "${marker}"
    timeout: 30000`
      : `- extendedWaitUntil:
    visible:
      text: "${marker}"
    timeout: 30000`;
  return `appId: ${appId}
---
${settle}
# Arm one sample window. Nothing is drawn while it runs, so the readout can
# never become part of what it measures.
- openLink: "centraid://perf-frames?ms=${SAMPLE_WINDOW_MS}"
${CONFIRM_SYSTEM_OPEN}# Prove the arm took BEFORE flinging — a fling against an unarmed sampler
# produces no report at all, and that failure would surface later and elsewhere.
- extendedWaitUntil:
    visible:
      id: "perf-frame-sampling"
    timeout: 10000
- repeat:
    times: ${FLINGS}
    commands:
      - swipe:
          direction: UP
          duration: 200
      - swipe:
          direction: DOWN
          duration: 200
# The readout is drawn only after the window closes.
- extendedWaitUntil:
    visible:
      id: "perf-frame-report"
    timeout: ${SAMPLE_WINDOW_MS + 15_000}
- copyTextFrom:
    id: "perf-frame-report"
- takeScreenshot: frame-report-${surface}
`;
}

await runFlow("mobile-scroll-frames", async (ctx) => {
  await ctx.configureGateway();

  const budgets = JSON.parse(
    await fs.readFile(
      path.join(REPO_ROOT, "tests/experience-budgets/mobile.json"),
      "utf8"
    )
  );
  const ceiling = budgets.metrics.maxDroppedFramePercent.maxPercent;

  const photosStartedAt = Date.now();
  await ctx.run(
    `appId: ${ctx.state.appId}
---
# The launcher tile by its handle. This was a bare tapOn: "Photos" — the tab
# label / route name that scripts/lint-e2e-flows.mjs refuses to let a flow
# ASSERT on, used here as a locator, where it is the same hazard: it matches
# whatever draws that word.
${AWAIT_LAUNCHER}
- tapOn:
    id: "home-tile-photos"
    retryTapIfNoChange: true
- extendedWaitUntil:
    visible:
      id: "photos-collections"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
# Photos opens on Collections, which is a shelf list, not the timeline. The
# grid this probe measures lives on the Library destination.
- tapOn:
    id: "photos-band-library"
    retryTapIfNoChange: true
`,
    "open-photos"
  );
  await ctx.run(
    flingYaml(ctx.state.appId, PHOTOS_MARKER, "id", "photos"),
    "fling-photos"
  );
  const photos = await readFrameEvidence(ctx.state.runDir, photosStartedAt);

  const unparsed = [["Photos", photos.report]]
    .filter(([, report]) => report === null)
    .map(([surface]) => surface);

  const worstDropped = photos.report?.dropped ?? 0;
  const drift = await rigDriftBudget(REPO_ROOT, "scale", OWNER);
  const withinDrift = drift == null || worstDropped <= drift;
  const passed =
    unparsed.length === 0 && worstDropped <= ceiling && withinDrift;

  await recordQualityResult(REPO_ROOT, {
    lane: "scale",
    owner: OWNER,
    name: `Frame drops over ${FLINGS} flings on Photos (JS thread only)`,
    status: passed ? "passed" : "failed",
    measurements: [
      {
        name: "worst dropped frames",
        value: worstDropped,
        unit: "percent",
        budget: drift == null ? ceiling : Math.min(drift, ceiling),
      },
      {
        name: "Photos dropped frames",
        value: photos.report?.dropped ?? -1,
        unit: "percent",
      },
      {
        name: "Photos display refresh rate",
        value: photos.report?.targetHz ?? -1,
        unit: "Hz",
      },
      { name: "Photos fps", value: photos.report?.fps ?? -1, unit: "fps" },
      { name: "flings per surface", value: FLINGS, unit: "count" },
    ],
  });

  ctx.note(
    `Photos ${photos.report?.dropped ?? "unparsed"}% dropped @ ${photos.report?.targetHz ?? "?"} Hz; ` +
      `ceiling ${ceiling}% (JS thread only — UI/native-thread jank is ` +
      `invisible to this sampler). People NOT MEASURED: the native directory ` +
      `was removed pending its v11 design handoff`
  );
  if (photos.report?.parse === "degraded") {
    ctx.note(
      "frame report was recovered by the DEGRADED parse — the exact line in " +
        "apps/mobile/src/lib/perf/frame-sampler.ts has changed; realign this " +
        "flow with frame-sampler.test.ts, which pins the contract"
    );
  }

  return {
    pass: passed,
    notes:
      unparsed.length > 0
        ? `no frame report parsed for ${unparsed.join(" and ")} — the sampler did not arm, or the readout id changed`
        : `worst ${worstDropped}% dropped frames against a ${ceiling}% ceiling`,
  };
});
