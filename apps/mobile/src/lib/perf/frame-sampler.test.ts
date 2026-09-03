import { describe, expect, test } from "vitest";

import {
  formatFrameSample,
  resolveTargetHz,
  sampleFrames,
} from "./frame-sampler";
import type { FrameSamplerDeps } from "./frame-sampler";

function display(periodMs: number, dropped: ReadonlySet<number> = new Set()) {
  let clock = 0;
  let tick = 0;
  const pending: Array<(time: number) => void> = [];
  const deps: FrameSamplerDeps = {
    now: () => clock,
    requestFrame: (frame) => {
      pending.push(frame);
    },
  };
  const run = async (): Promise<void> => {
    const frame = pending.shift();
    if (!frame) return;
    frame(clock);
    tick += 1;
    clock += dropped.has(tick) ? periodMs * 2 : periodMs;
    await Promise.resolve();
    return run();
  };
  return { deps, run };
}

describe(sampleFrames, () => {
  test("a display that never misses reports zero dropped frames", async () => {
    const { deps, run } = display(1_000 / 60);
    const sampling = sampleFrames(500, deps);
    await run();
    const sample = await sampling;

    expect(sample.targetHz).toBe(60);
    expect(sample.droppedPercent).toBe(0);
    expect(sample.frames).toBe(sample.expectedFrames);
    expect(sample.fps).toBeCloseTo(60, 0);
  });

  test("missed slots show up as dropped frames", async () => {
    const dropped = new Set(
      Array.from({ length: 200 }, (_, index) => index * 3 + 1)
    );
    const { deps, run } = display(1_000 / 60, dropped);
    const sampling = sampleFrames(1_000, deps);
    await run();
    const sample = await sampling;

    expect(sample.targetHz).toBe(60);
    expect(sample.droppedPercent).toBeGreaterThan(25);
    expect(sample.droppedPercent).toBeLessThan(40);
  });

  test("60 fps on a 120 Hz display is not reported as perfect", async () => {
    const { deps, run } = display(
      1_000 / 120,
      new Set(Array.from({ length: 400 }, (_, index) => index * 2 + 2))
    );
    const sampling = sampleFrames(1_000, deps);
    await run();
    const sample = await sampling;

    expect(sample.targetHz).toBe(120);
    expect(sample.droppedPercent).toBeGreaterThan(20);
  });

  test("scheduling the first frame is not charged as a drop", async () => {
    let clock = 0;
    const pending: Array<(time: number) => void> = [];
    const deps: FrameSamplerDeps = {
      now: () => clock,
      requestFrame: (frame) => {
        pending.push(frame);
      },
    };
    const sampling = sampleFrames(100, deps);
    clock = 5_000;
    const drain = async (): Promise<void> => {
      const frame = pending.shift();
      if (!frame) return;
      frame(clock);
      clock += 1_000 / 60;
      await Promise.resolve();
      return drain();
    };
    await drain();
    const sample = await sampling;

    expect(sample.elapsedMs).toBeLessThan(200);
    expect(sample.droppedPercent).toBe(0);
  });
});

describe(resolveTargetHz, () => {
  test("falls back to 60 with nothing to go on", () => {
    expect(resolveTargetHz([])).toBe(60);
  });

  test("an off-rate display keeps its measured rate rather than snapping", () => {
    expect(resolveTargetHz(Array.from({ length: 20 }, () => 5))).toBeCloseTo(
      200,
      0
    );
  });
});

describe(formatFrameSample, () => {
  test("round-trips through the string the probe copies out", () => {
    const sample = {
      frames: 137,
      expectedFrames: 241,
      elapsedMs: 4_016.4,
      fps: 34.11,
      targetHz: 60,
      droppedPercent: 43.15,
    };
    const line = formatFrameSample(sample);

    expect(line).toBe(
      "frames=137 expected=241 elapsed=4016ms fps=34.11 targetHz=60 dropped=43.15%"
    );
    expect(/dropped=(?<percent>[0-9.]+)%/u.exec(line)?.groups?.percent).toBe(
      "43.15"
    );
  });
});
