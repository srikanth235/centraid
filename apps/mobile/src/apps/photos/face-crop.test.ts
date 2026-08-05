import { describe, expect, it } from "vitest";

import { faceCropStyle } from "./face-crop";

// Same fixtures as the web twin (packages/blueprints/apps/photos/
// face-crop.test.ts) — the two must agree since the crop math is duplicated
// on purpose (see this file's own header) rather than shared.
describe("faceCropStyle (native)", () => {
  it("centers the rendered image on the bbox center", () => {
    const style = faceCropStyle(
      { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
      1000,
      1000,
      120
    );
    expect(style).not.toBeNull();
    const centerX = 500 * (style!.width / 1000) + style!.left;
    const centerY = 500 * (style!.height / 1000) + style!.top;
    expect(centerX).toBeCloseTo(60, 5);
    expect(centerY).toBeCloseTo(60, 5);
  });

  it("scales up a tiny face to fill the box", () => {
    const style = faceCropStyle(
      { x: 0.1, y: 0.1, w: 0.05, h: 0.05 },
      2000,
      2000,
      120
    );
    expect(style).not.toBeNull();
    expect(style!.width).toBeGreaterThan(120);
  });

  it("returns null without a usable bbox or image size", () => {
    expect(faceCropStyle(null, 1000, 1000, 120)).toBeNull();
    expect(
      faceCropStyle({ x: 0, y: 0, w: 0.2, h: 0.2 }, null, 1000, 120)
    ).toBeNull();
    expect(
      faceCropStyle({ x: 0, y: 0, w: 0, h: 0.2 }, 1000, 1000, 120)
    ).toBeNull();
  });

  it("never distorts aspect ratio", () => {
    const style = faceCropStyle(
      { x: 0.2, y: 0.3, w: 0.15, h: 0.25 },
      1600,
      1200,
      120
    );
    expect(style).not.toBeNull();
    expect(style!.width / style!.height).toBeCloseTo(1600 / 1200, 5);
  });
});
