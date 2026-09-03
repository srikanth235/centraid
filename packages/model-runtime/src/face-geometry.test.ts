import { describe, expect, it } from "vitest";

import {
  applyTransform,
  computeSimilarityTransform,
  decodeYuNetLevel,
  sigmoid,
  warpAffine,
} from "./face-geometry.js";

describe(sigmoid, () => {
  it("maps 0 to 0.5", () => {
    expect(sigmoid(0)).toBeCloseTo(0.5, 10);
  });

  it("saturates toward 1 for large positive input", () => {
    expect(sigmoid(20)).toBeGreaterThan(0.999);
  });

  it("saturates toward 0 for large negative input", () => {
    expect(sigmoid(-20)).toBeLessThan(0.001);
  });
});

describe(decodeYuNetLevel, () => {
  it("decodes a single grid cell with identity regression to its cell-center box", () => {
    const results = decodeYuNetLevel(
      {
        stride: 8,
        gridWidth: 1,
        gridHeight: 1,
        classScores: [0.5],
        objectness: [0.5],
        boxes: [0, 0, 0, 0],
      },
      0.4
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.score).toBeCloseTo(0.5, 10);
    expect(results[0]?.box).toStrictEqual({
      x: -4,
      y: -4,
      width: 8,
      height: 8,
    });
  });

  it("filters out cells below the score threshold", () => {
    const results = decodeYuNetLevel(
      {
        stride: 8,
        gridWidth: 1,
        gridHeight: 1,
        classScores: [0],
        objectness: [1],
        boxes: [0, 0, 0, 0],
      },
      0.4
    );
    expect(results).toStrictEqual([]);
  });

  it("decodes landmarks relative to the cell center", () => {
    const results = decodeYuNetLevel(
      {
        stride: 8,
        gridWidth: 1,
        gridHeight: 1,
        classScores: [0.5],
        objectness: [0.5],
        boxes: [0, 0, 0, 0],
        landmarks: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      },
      0.4
    );
    expect(results[0]?.landmarks).toStrictEqual([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ]);
  });

  it("scans a 2x2 grid and only keeps the high-scoring cell", () => {
    const results = decodeYuNetLevel(
      {
        stride: 8,
        gridWidth: 2,
        gridHeight: 2,
        classScores: [0, 0, 1, 0],
        objectness: [1, 1, 1, 1],
        boxes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      },
      0.5
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.box).toStrictEqual({ x: -4, y: 4, width: 8, height: 8 });
  });
});

describe("computeSimilarityTransform + applyTransform", () => {
  it("recovers a pure translation exactly", () => {
    const src = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ].map((p) => ({ x: p.x + 5, y: p.y + 3 }));
    const dst = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];

    const transform = computeSimilarityTransform(src, dst);
    expect(transform.a).toBeCloseTo(1, 8);
    expect(transform.b).toBeCloseTo(0, 8);
    expect(transform.tx).toBeCloseTo(-5, 8);
    expect(transform.ty).toBeCloseTo(-3, 8);
  });

  it("recovers a known scale+rotation+translation exactly (3 points, consistent data)", () => {
    const src = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ];
    const dst = [
      { x: 10, y: 20 },
      { x: 10, y: 22 },
      { x: 8, y: 20 },
    ];

    const transform = computeSimilarityTransform(src, dst);
    expect(transform.a).toBeCloseTo(0, 8);
    expect(transform.b).toBeCloseTo(2, 8);
    expect(transform.tx).toBeCloseTo(10, 8);
    expect(transform.ty).toBeCloseTo(20, 8);

    for (const [i, point] of src.entries()) {
      const mapped = applyTransform(transform, point);
      expect(mapped.x).toBeCloseTo((dst[i] as { x: number }).x, 6);
      expect(mapped.y).toBeCloseTo((dst[i] as { y: number }).y, 6);
    }
  });

  it("throws on mismatched or empty point arrays", () => {
    expect(() => computeSimilarityTransform([], [])).toThrow(
      /same non-zero length/u
    );
    expect(() => computeSimilarityTransform([{ x: 0, y: 0 }], [])).toThrow(
      /same non-zero length/u
    );
  });
});

describe(warpAffine, () => {
  it("is a no-op under the identity transform (a=1,b=0,tx=0,ty=0)", () => {
    const image = {
      data: new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]),
      width: 2,
      height: 2,
    };
    const warped = warpAffine(image, { a: 1, b: 0, tx: 0, ty: 0 }, 2, 2);
    expect(Array.from(warped.data)).toStrictEqual(Array.from(image.data));
  });

  it("shifts the sampled content under a pure-translation transform", () => {
    const image = {
      data: new Uint8Array([0, 0, 0, 100, 100, 100, 200, 200, 200]),
      width: 3,
      height: 1,
    };
    const warped = warpAffine(image, { a: 1, b: 0, tx: 1, ty: 0 }, 3, 1);
    expect(warped.data[3]).toBe(0);
    expect(warped.data[6]).toBe(100);
  });
});
