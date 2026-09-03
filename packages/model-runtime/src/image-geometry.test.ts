import { describe, expect, it } from "vitest";

import {
  computeBoundedMultipleResize,
  roundAndClampBox,
  roundBox,
  scaleBoxToOriginal,
} from "./image-geometry.js";

describe(computeBoundedMultipleResize, () => {
  it("leaves a small image unscaled, rounding each dimension to the nearest multiple", () => {
    expect(computeBoundedMultipleResize(100, 50, 960, 32)).toStrictEqual({
      width: 96,
      height: 64,
    });
  });

  it("downscales an oversized image so the longer side fits maxSide, then rounds to the multiple", () => {
    expect(computeBoundedMultipleResize(1000, 2000, 960, 32)).toStrictEqual({
      width: 480,
      height: 960,
    });
  });

  it("never returns a dimension smaller than one multiple", () => {
    const result = computeBoundedMultipleResize(1, 1, 960, 32);
    expect(result.width).toBeGreaterThanOrEqual(32);
    expect(result.height).toBeGreaterThanOrEqual(32);
  });
});

describe(scaleBoxToOriginal, () => {
  it("scales a box up when the original is larger than the resized image", () => {
    const box = { x: 10, y: 10, width: 20, height: 20 };
    const resized = { width: 100, height: 100 };
    const original = { width: 200, height: 400 };
    expect(scaleBoxToOriginal(box, resized, original)).toStrictEqual({
      x: 20,
      y: 40,
      width: 40,
      height: 80,
    });
  });

  it("is a no-op when resized and original dimensions match", () => {
    const box = { x: 5, y: 5, width: 10, height: 10 };
    const size = { width: 100, height: 100 };
    expect(scaleBoxToOriginal(box, size, size)).toStrictEqual(box);
  });
});

describe(roundBox, () => {
  it("rounds each field to the nearest integer and returns a tuple", () => {
    expect(roundBox({ x: 1.4, y: 1.5, width: 2.6, height: 2.4 })).toStrictEqual(
      [1, 2, 3, 2]
    );
  });
});

describe(roundAndClampBox, () => {
  it("never lets x + width exceed the declared bound, even when independent rounding would", () => {
    const [x, , w] = roundAndClampBox(
      { x: 9.6, y: 0, width: 0.9, height: 1 },
      10,
      10
    );
    expect(x + w).toBeLessThanOrEqual(10);
  });

  it("clamps a box that overhangs the bounds and never returns a negative coordinate", () => {
    expect(
      roundAndClampBox({ x: -5, y: -5, width: 20, height: 20 }, 10, 10)
    ).toStrictEqual([0, 0, 10, 10]);
  });

  it("leaves an in-bounds integer box unchanged", () => {
    expect(
      roundAndClampBox({ x: 1, y: 2, width: 3, height: 4 }, 20, 20)
    ).toStrictEqual([1, 2, 3, 4]);
  });
});
