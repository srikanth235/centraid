import { describe, expect, test } from "vitest";

import {
  scrubFrameTimestampsMs,
  SCRUB_STRIP_FRAME_COUNT,
} from "./video-scrub-strip";

describe("sample timestamps", () => {
  test("spreads evenly across the clip, starting at zero", () => {
    const timestamps = scrubFrameTimestampsMs(6_000, 6);
    expect(timestamps[0]).toBe(0);
    expect(timestamps).toHaveLength(6);
    expect(timestamps[timestamps.length - 1]!).toBeLessThan(6_000);
  });

  test("a clip too short for the full count returns fewer, never duplicates", () => {
    const timestamps = scrubFrameTimestampsMs(2, 6);
    expect(new Set(timestamps).size).toBe(timestamps.length);
    expect(timestamps.length).toBeLessThan(6);
  });

  test("a zero or unknown duration is one frame at zero, never a crash", () => {
    expect(scrubFrameTimestampsMs(0)).toStrictEqual([0]);
    expect(scrubFrameTimestampsMs(Number.NaN)).toStrictEqual([0]);
  });

  test("the default count matches the exported constant", () => {
    expect(scrubFrameTimestampsMs(10_000)).toHaveLength(
      SCRUB_STRIP_FRAME_COUNT
    );
  });
});
