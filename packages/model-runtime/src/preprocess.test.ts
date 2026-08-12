import { describe, expect, it } from "vitest";

import {
  cropImage,
  normalizeClip,
  normalizeImageNet,
  toOpenCvBgrPlanar,
  toOpenCvRgbPlanar,
} from "./preprocess.js";

// Only the pure buffer-math helpers are covered here. decodeImage*/
// resizeDecodedImage go through sharp (lazily loaded from
// runtime/node_modules, see the file header) and are exercised by hand once
// `bun run setup` has installed the runtime — see README.md.

describe(cropImage, () => {
  it("extracts the requested region from an interleaved RGB buffer", () => {
    // 3x1 image, pixels red/green/blue
    const image = {
      data: new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]),
      width: 3,
      height: 1,
    };
    const cropped = cropImage(image, { x: 1, y: 0, width: 2, height: 1 });
    expect(cropped.width).toBe(2);
    expect(cropped.height).toBe(1);
    expect(Array.from(cropped.data)).toStrictEqual([0, 255, 0, 0, 0, 255]);
  });

  it("clamps a region that overhangs the image bounds", () => {
    const image = { data: new Uint8Array(3 * 2 * 3), width: 3, height: 2 };
    const cropped = cropImage(image, { x: -1, y: -1, width: 10, height: 10 });
    expect(cropped.width).toBe(3);
    expect(cropped.height).toBe(2);
  });
});

describe(normalizeClip, () => {
  it("produces planar CHW output scaled to roughly [-2, 2]", () => {
    const image = {
      data: new Uint8Array([255, 255, 255, 0, 0, 0]),
      width: 2,
      height: 1,
    };
    const out = normalizeClip(image);
    expect(out).toHaveLength(2 * 3);
    // channel 0, pixel 0 (white): (1 - mean) / std, a positive value
    expect(out[0]).toBeGreaterThan(0);
    // channel 0, pixel 1 (black): (0 - mean) / std, a negative value
    expect(out[1]).toBeLessThan(0);
  });
});

describe(normalizeImageNet, () => {
  it("produces planar CHW output of the expected length", () => {
    const image = {
      data: new Uint8Array([128, 128, 128, 64, 64, 64]),
      width: 2,
      height: 1,
    };
    expect(normalizeImageNet(image)).toHaveLength(2 * 3);
  });
});

describe(toOpenCvBgrPlanar, () => {
  it("matches OpenCV blobFromImage's unscaled BGR channel planes", () => {
    const image = {
      data: new Uint8Array([10, 20, 30, 40, 50, 60]),
      width: 2,
      height: 1,
    };
    expect(Array.from(toOpenCvBgrPlanar(image))).toStrictEqual([
      30, 60, 20, 50, 10, 40,
    ]);
  });
});

describe(toOpenCvRgbPlanar, () => {
  it("matches SFace's unscaled RGB channel planes", () => {
    const image = {
      data: new Uint8Array([10, 20, 30, 40, 50, 60]),
      width: 2,
      height: 1,
    };
    expect(Array.from(toOpenCvRgbPlanar(image))).toStrictEqual([
      10, 40, 20, 50, 30, 60,
    ]);
  });
});
