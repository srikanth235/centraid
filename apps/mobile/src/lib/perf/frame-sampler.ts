export interface FrameSample {
  frames: number;
  expectedFrames: number;
  elapsedMs: number;
  fps: number;
  targetHz: number;
  droppedPercent: number;
}

export interface FrameSamplerDeps {
  requestFrame: (callback: (timestampMs: number) => void) => void;
  now: () => number;
}

const KNOWN_REFRESH_HZ = [120, 90, 60, 30] as const;
const SNAP_TOLERANCE = 0.12;

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
