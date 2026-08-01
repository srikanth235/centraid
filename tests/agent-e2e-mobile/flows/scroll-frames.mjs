import { promises as fs } from "node:fs";
import path from "node:path";

import {
  recordQualityResult,
  rigDriftBudget,
} from "../../agent-e2e-shared/harness.mjs";
import { readFrameEvidence } from "../lib/frame-report.mjs";
import { runFlow } from "../lib/harness.mjs";

/**
 * Frame-drop probe for the Photos grid and the People directory
 * (issue #659 R3c).
 *
 * The first cut of this flow measured scroll-SETTLE wall clock, because React
 * Native exposed no frame timeline to Maestro and the honest number needed an
 * instrumentation hook inside `apps/mobile/src`. That hook now exists
 * (`apps/mobile/src/lib/perf/frame-sampler.ts` + `src/kit/perf/FrameProbe.tsx`),
 * so this flow measures the real thing and the settle-time proxy is gone — a
 * weaker signal kept beside a stronger one is just a second number nobody knows
 * how to read.
 *
 * ── The contract (owned by apps/mobile, pinned by frame-sampler.test.ts) ────
 *
 *   arm     `openLink: centraid://perf-frames?ms=<window>`  (default 4000,
 *           capped 30000; arming is idempotent while a sample runs)
 *   armed   a 1x1 view with `testID: perf-frame-sampling` exists for the window
 *   report  on close, `testID: perf-frame-report` renders EXACTLY:
 *           `frames=137 expected=241 elapsed=4016ms fps=34.11 targetHz=60 dropped=43.15%`
 *
 * `copyTextFrom` is the blessed read and this flow issues it — it fails loudly
 * if the id is absent, which is the assertion that matters. But Maestro keeps
 * `maestro.copiedText` inside the flow and offers no supported channel back to
 * a `.mjs` host, so the NUMBER is recovered from the view hierarchies
 * `--debug-output` already writes under `runs/<id>/maestro-debug/`, where the
 * report string appears verbatim. Parsing is deliberately two-tier: the strict
 * whole-line pattern first, then an independent `dropped=` / `targetHz=` scan,
 * so a change that escapes or splits the line degrades to a still-correct read
 * instead of a silent zero. A phase that yields NO parse FAILS the flow —
 * "we could not see the frames" must never read as "no frames were dropped".
 *
 * ── Two caveats that travel with every number this produces ─────────────────
 *
 * 1. **`targetHz` is not 60.** The sampler derives the display's true refresh
 *    rate from the 10th-percentile inter-frame interval and snaps to
 *    120/90/60/30 Hz, so `dropped` has a per-device denominator. It is recorded
 *    beside every percentage below; without it, 60 fps on a 120 Hz ProMotion
 *    device reads as a flawless run when half the frames are missing.
 * 2. **JS thread only.** The sampler counts `requestAnimationFrame` callbacks,
 *    so jank originating on the UI/native thread — a Reanimated worklet, a
 *    native image decode — is invisible to it. This is a real frame-drop number
 *    for the JS thread, NOT a compositor-level guarantee.
 *
 * ── Year-3 declared volume (docs/coding-standards.md D6) ────────────────────
 *
 * | Surface | Year-3         | Seeded here |
 * | ------- | -------------- | ----------- |
 * | Photos  | 90,000 assets  | whatever the CI gateway fixture seeded — NOT year-3 |
 * | People  | 5,000 contacts | whatever the CI gateway fixture seeded — NOT year-3 |
 *
 * The seeded totals are not observable from the device, so this flow does not
 * guess them. What it CAN observe it reports: `people-directory-row-<index>` is
 * positional, so the highest index appearing in any hierarchy during the fling
 * is a real lower bound on the rows scrolled past, published as
 * `people rows observed`. A fling over a directory that turns out to hold 12
 * rows says nothing about a 5,000-row one, and that lower bound is what lets a
 * reader tell the two apart instead of inferring it from seed code.
 */
const OWNER = "tests/agent-e2e-mobile/flows/scroll-frames.mjs";
const FLINGS = 8;
const SAMPLE_WINDOW_MS = 6_000;
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

// A durable accessibilityLabel published by PhotosHome's search control
// (apps/mobile/src/apps/photos/PhotosHome.tsx). Deliberately NOT the "Photos"
// tab label, which the tab bar draws on every screen.
const PHOTOS_MARKER = "Search photos and moments";
// People's list handle (apps/mobile/src/apps/people/PeopleHome.tsx). Positional
// row ids exist whatever the fixture seeded, and `people-directory-row-0` is
// People-specific so it cannot pass on another screen.
const PEOPLE_ROW_ZERO = "people-directory-row-0";

/** Arm the sampler, fling the surface under test, and read the report back. */
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
# Prove the arm took BEFORE flinging — a fling against an unarmed sampler
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

  // ---- Photos grid ---------------------------------------------------------
  const photosStartedAt = Date.now();
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- tapOn: "Photos"
`,
    "open-photos"
  );
  await ctx.run(
    flingYaml(ctx.state.appId, PHOTOS_MARKER, "text", "photos"),
    "fling-photos"
  );
  const photos = await readFrameEvidence(ctx.state.runDir, photosStartedAt);

  // ---- People directory ----------------------------------------------------
  const peopleStartedAt = Date.now();
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- tapOn: "People"
`,
    "open-people"
  );
  await ctx.run(
    flingYaml(ctx.state.appId, PEOPLE_ROW_ZERO, "id", "people"),
    "fling-people"
  );
  const people = await readFrameEvidence(ctx.state.runDir, peopleStartedAt);

  // A phase that produced no parse is a FAILURE, not a pass with a hole in it.
  const unparsed = [
    ["Photos", photos.report],
    ["People", people.report],
  ]
    .filter(([, report]) => report === null)
    .map(([surface]) => surface);

  const worstDropped = Math.max(
    photos.report?.dropped ?? 0,
    people.report?.dropped ?? 0
  );
  const drift = await rigDriftBudget(REPO_ROOT, "scale", OWNER);
  const withinDrift = drift == null || worstDropped <= drift;
  const passed =
    unparsed.length === 0 && worstDropped <= ceiling && withinDrift;

  await recordQualityResult(REPO_ROOT, {
    lane: "scale",
    owner: OWNER,
    name: `Frame drops over ${FLINGS} flings on Photos and People (JS thread only)`,
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
        // Recorded beside every percentage: the denominator is per-device, so a
        // comparison that drops it is comparing two different questions.
        name: "Photos display refresh rate",
        value: photos.report?.targetHz ?? -1,
        unit: "Hz",
      },
      { name: "Photos fps", value: photos.report?.fps ?? -1, unit: "fps" },
      {
        name: "People dropped frames",
        value: people.report?.dropped ?? -1,
        unit: "percent",
      },
      {
        name: "People display refresh rate",
        value: people.report?.targetHz ?? -1,
        unit: "Hz",
      },
      { name: "People fps", value: people.report?.fps ?? -1, unit: "fps" },
      {
        // Observed lower bound on the seeded directory (D6) — the real total is
        // not visible from the device, so this is what can honestly be claimed.
        name: "people rows observed (lower bound on seeded volume)",
        value: people.peopleRowsObserved,
        unit: "rows",
      },
      { name: "flings per surface", value: FLINGS, unit: "count" },
    ],
  });

  ctx.note(
    `Photos ${photos.report?.dropped ?? "unparsed"}% dropped @ ${photos.report?.targetHz ?? "?"} Hz; ` +
      `People ${people.report?.dropped ?? "unparsed"}% dropped @ ${people.report?.targetHz ?? "?"} Hz ` +
      `over at least ${people.peopleRowsObserved} rows; ceiling ${ceiling}% ` +
      `(JS thread only — UI/native-thread jank is invisible to this sampler)`
  );
  if (
    photos.report?.parse === "degraded" ||
    people.report?.parse === "degraded"
  ) {
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
