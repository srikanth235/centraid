import { describe, expect, it } from "vitest";

import {
  binarizeProbabilityMap,
  clampBoxToImage,
  dbPostprocess,
  findConnectedComponents,
  meanProbabilityInBox,
  unclipBox,
} from "./ocr-postprocess.js";

describe(binarizeProbabilityMap, () => {
  it("keeps pixels at or above the threshold and drops the rest", () => {
    const probs = [0.1, 0.3, 0.5, 0.29];
    expect(binarizeProbabilityMap(probs, 4, 1, 0.3)).toStrictEqual(
      new Uint8Array([0, 1, 1, 0])
    );
  });
});

describe(findConnectedComponents, () => {
  it("finds a single 2x2 square component and its bounding box", () => {
    const width = 4;
    const height = 4;
    const mask = new Uint8Array(width * height);
    for (const [x, y] of [
      [1, 1],
      [2, 1],
      [1, 2],
      [2, 2],
    ]) {
      mask[(y as number) * width + (x as number)] = 1;
    }

    const components = findConnectedComponents(mask, width, height);
    expect(components).toHaveLength(1);
    expect(components[0]).toStrictEqual({
      box: { x: 1, y: 1, width: 2, height: 2 },
      area: 4,
    });
  });

  it("treats diagonally-touching pixels as separate components (4-connectivity only)", () => {
    const width = 3;
    const height = 3;
    const mask = new Uint8Array(width * height);
    mask[0] = 1; // (0,0)
    mask[4] = 1; // (1,1) — diagonal neighbor of (0,0), not 4-connected

    const components = findConnectedComponents(mask, width, height);
    expect(components).toHaveLength(2);
  });

  it("filters components below minArea", () => {
    const width = 3;
    const height = 1;
    const mask = new Uint8Array([1, 0, 0]);
    expect(findConnectedComponents(mask, width, height, 2)).toStrictEqual([]);
  });
});

describe(unclipBox, () => {
  it("expands a box symmetrically using PaddleOCR's distance formula", () => {
    const box = { x: 10, y: 10, width: 10, height: 10 };
    const area = 100;
    const expanded = unclipBox(box, area, 1.5);
    expect(expanded).toStrictEqual({
      x: 6.25,
      y: 6.25,
      width: 17.5,
      height: 17.5,
    });
  });

  it("returns the box unchanged when perimeter is zero", () => {
    const box = { x: 0, y: 0, width: 0, height: 0 };
    expect(unclipBox(box, 0, 1.5)).toStrictEqual(box);
  });
});

describe(clampBoxToImage, () => {
  it("clips a box that overhangs the image bounds", () => {
    expect(
      clampBoxToImage({ x: -5, y: -5, width: 20, height: 20 }, 10, 10)
    ).toStrictEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
  });

  it("rounds fractional coordinates to integer pixels", () => {
    expect(
      clampBoxToImage({ x: 1.4, y: 1.6, width: 3, height: 3 }, 10, 10)
    ).toStrictEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 3,
    });
  });
});

describe(meanProbabilityInBox, () => {
  it("averages exactly the pixels covered by the box", () => {
    const probs = [0.2, 0.8, 0.4];
    expect(
      meanProbabilityInBox(probs, 3, { x: 1, y: 0, width: 2, height: 1 })
    ).toBeCloseTo(0.6, 10);
  });
});

describe(dbPostprocess, () => {
  it("finds and scores a synthetic text-line-shaped high-probability region", () => {
    const width = 10;
    const height = 10;
    const probs = Array.from({ length: width * height }, () => 0.05);
    for (let y = 3; y <= 5; y++) {
      for (let x = 2; x <= 7; x++) {
        probs[y * width + x] = 0.95;
      }
    }

    const results = dbPostprocess(probs, width, height, { unclipRatio: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]?.score).toBeCloseTo(0.95, 5);
    expect(results[0]?.box).toStrictEqual({ x: 2, y: 3, width: 6, height: 3 });
  });

  it("finds nothing when the whole map is below the binary threshold", () => {
    const probs = Array.from({ length: 100 }, () => 0.01);
    expect(dbPostprocess(probs, 10, 10)).toStrictEqual([]);
  });
});
