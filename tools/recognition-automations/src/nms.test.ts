import { describe, expect, it } from "vitest";

import { boxArea, iou, nonMaxSuppression } from "./nms.js";

describe(boxArea, () => {
  it("multiplies width by height", () => {
    expect(boxArea({ x: 0, y: 0, width: 4, height: 5 })).toBe(20);
  });

  it("treats a negative dimension as zero area", () => {
    expect(boxArea({ x: 0, y: 0, width: -4, height: 5 })).toBe(0);
  });
});

describe(iou, () => {
  it("is 1 for two identical boxes", () => {
    const box = { x: 0, y: 0, width: 10, height: 10 };
    expect(iou(box, box)).toBe(1);
  });

  it("is 0 for two disjoint boxes", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    const b = { x: 100, y: 100, width: 10, height: 10 };
    expect(iou(a, b)).toBe(0);
  });

  it("computes the standard intersection-over-union for a partial overlap", () => {
    // a: [0,0]-[10,10] (area 100); b: [5,5]-[15,15] (area 100)
    // intersection: [5,5]-[10,10] = 5x5 = 25; union = 100+100-25 = 175
    const a = { x: 0, y: 0, width: 10, height: 10 };
    const b = { x: 5, y: 5, width: 10, height: 10 };
    expect(iou(a, b)).toBeCloseTo(25 / 175, 10);
  });

  it("is 0 when boxes only touch at an edge (zero-area intersection)", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    const b = { x: 10, y: 0, width: 10, height: 10 };
    expect(iou(a, b)).toBe(0);
  });
});

describe(nonMaxSuppression, () => {
  it("keeps the highest-scoring box and suppresses an overlapping lower-scoring one", () => {
    const boxes = [
      { box: { x: 0, y: 0, width: 10, height: 10 }, score: 0.9 },
      { box: { x: 1, y: 1, width: 10, height: 10 }, score: 0.5 },
    ];
    const kept = nonMaxSuppression(boxes, { iouThreshold: 0.3 });
    expect(kept).toHaveLength(1);
    expect(kept[0]?.score).toBe(0.9);
  });

  it("keeps both boxes when they don't overlap enough to trip the threshold", () => {
    const boxes = [
      { box: { x: 0, y: 0, width: 10, height: 10 }, score: 0.9 },
      { box: { x: 100, y: 100, width: 10, height: 10 }, score: 0.5 },
    ];
    const kept = nonMaxSuppression(boxes, { iouThreshold: 0.3 });
    expect(kept).toHaveLength(2);
  });

  it("respects topK after suppression", () => {
    const boxes = [
      { box: { x: 0, y: 0, width: 10, height: 10 }, score: 0.9 },
      { box: { x: 50, y: 50, width: 10, height: 10 }, score: 0.8 },
      { box: { x: 100, y: 100, width: 10, height: 10 }, score: 0.7 },
    ];
    const kept = nonMaxSuppression(boxes, { iouThreshold: 0.3, topK: 2 });
    expect(kept.map((b) => b.score)).toStrictEqual([0.9, 0.8]);
  });
});
