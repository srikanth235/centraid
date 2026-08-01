// Frame-drop instrumentation for the #659 scroll probe.
//
// React Native publishes no frame timeline to Maestro or adb, so a frame-drop
// number can only come from inside the app. This is that hook and nothing more:
// it counts `requestAnimationFrame` callbacks over a window the probe asks for,
// and reports how many the display could have delivered in the same window.
//
// Two things keep it honest.
//
// **It self-calibrates the denominator.** A 60 fps result is excellent on a
// 60 Hz phone and 50 % dropped on a ProMotion iPhone, so a hardcoded 60 would
// report whatever the author assumed rather than what the device did. The target
// rate is derived from the fastest intervals actually observed in the sample —
// the periods where nothing was dropped — and snapped to a real display rate.
// The resolved rate is reported alongside the percentage so no reader has to
// guess which denominator produced it.
//
// **It runs only when asked.** There is no ambient timer: `sampleFrames`
// schedules the first frame when it is called and stops scheduling when the
// window closes. Nothing in this module starts on import (D5 — every poller
// justified; this one exists for the duration of one measurement).

export interface FrameSample {
  /** Frames the app actually rendered inside the window. */
  frames: number;
  /** Frames the display could have delivered at `targetHz`. */
  expectedFrames: number;
  elapsedMs: number;
  /** Frames per second the app sustained across the window. */
  fps: number;
  /** Display rate the sample resolved to; the denominator for `droppedPercent`. */
  targetHz: number;
  /** `(expected - frames) / expected`, clamped at zero, as a percentage. */
  droppedPercent: number;
}

export interface FrameSamplerDeps {
  requestFrame: (callback: (timestampMs: number) => void) => void;
  now: () => number;
}

/** Rates a real display runs at. A p10 interval near one of these snaps to it. */
const KNOWN_REFRESH_HZ = [120, 90, 60, 30] as const;
const SNAP_TOLERANCE = 0.12;

/**
 * Count rendered frames for `durationMs`, then report against the rate the
 * device demonstrated it can hit.
 *
 * The window is measured from the first callback rather than from the call, so
 * the cost of scheduling the first frame is not charged as a drop.
 */
export async function sampleFrames(
  durationMs: number,
  deps: FrameSamplerDeps
): Promise<FrameSample> {
  const intervals: number[] = [];
  let frames = 0;
  let startedAt: number | undefined;
  let previous: number | undefined;

  await new Promise<void>((resolve) => {
    const onFrame = (): void => {
      const at = deps.now();
      if (startedAt === undefined) {
        startedAt = at;
        previous = at;
        deps.requestFrame(onFrame);
        return;
      }
      frames += 1;
      intervals.push(at - previous!);
      previous = at;
      if (at - startedAt >= durationMs) {
        resolve();
        return;
      }
      deps.requestFrame(onFrame);
    };
    deps.requestFrame(onFrame);
  });

  const elapsedMs = previous! - startedAt!;
  const targetHz = resolveTargetHz(intervals);
  const expectedFrames = Math.max(
    1,
    Math.round((elapsedMs / 1_000) * targetHz)
  );
  const fps = elapsedMs > 0 ? (frames / elapsedMs) * 1_000 : 0;
  return {
    frames,
    expectedFrames,
    elapsedMs,
    fps,
    targetHz,
    droppedPercent: Math.max(
      0,
      ((expectedFrames - frames) / expectedFrames) * 100
    ),
  };
}

/**
 * The rate the display was capable of during this sample.
 *
 * The 10th-percentile interval is the app's best sustained pace: a single
 * anomalously short delta cannot move it the way a minimum could, and dropped
 * frames only ever make intervals longer. Snapping to a real refresh rate when
 * it is close keeps the denominator from drifting run to run.
 */
export function resolveTargetHz(intervals: readonly number[]): number {
  const positive = intervals
    .filter((interval) => interval > 0)
    .sort((a, b) => a - b);
  if (positive.length === 0) return 60;
  const p10 = positive[Math.floor((positive.length - 1) * 0.1)]!;
  const observedHz = 1_000 / p10;
  const snapped = KNOWN_REFRESH_HZ.find(
    (hz) => Math.abs(observedHz - hz) / hz <= SNAP_TOLERANCE
  );
  return snapped ?? observedHz;
}

/**
 * One line the probe copies out. Machine-first on purpose: the harness reads it
 * with a Maestro `copyTextFrom`, so it has to survive being turned into a plain
 * string with no structure around it. The exact string is pinned by this
 * module's test — that assertion is the contract with
 * `tests/agent-e2e-mobile/flows/scroll-frames.mjs`, which parses it with
 * a `dropped=<number>%` match. No parser lives here: the probe is `.mjs` and
 * could not import one.
 */
export function formatFrameSample(sample: FrameSample): string {
  return [
    `frames=${sample.frames}`,
    `expected=${sample.expectedFrames}`,
    `elapsed=${Math.round(sample.elapsedMs)}ms`,
    `fps=${sample.fps.toFixed(2)}`,
    `targetHz=${Math.round(sample.targetHz)}`,
    `dropped=${sample.droppedPercent.toFixed(2)}%`,
  ].join(" ");
}
