import { describe, expect, it } from "vitest";

import { faceCropStyle } from "./face-crop.ts";

describe(faceCropStyle, () => {
  it("centers the rendered image on the bbox center", () => {
    // A 1000x1000 image, bbox at (0.4,0.4)-(0.6,0.6) — a centered 200x200
    // square face region.
    const style = faceCropStyle(
      { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
      1000,
      1000,
      180
    );
    expect(style).not.toBeNull();
    // The bbox center (500,500) must land at the box's own center (90,90).
    const centerX = 500 * (style!.width / 1000) + style!.left;
    const centerY = 500 * (style!.height / 1000) + style!.top;
    expect(centerX).toBeCloseTo(90, 5);
    expect(centerY).toBeCloseTo(90, 5);
  });

  it("scales up a tiny face to fill the box", () => {
    const style = faceCropStyle(
      { x: 0.1, y: 0.1, w: 0.05, h: 0.05 },
      2000,
      2000,
      180
    );
    expect(style).not.toBeNull();
    // The image must be rendered LARGER than the box — a 5% bbox needs zoom.
    expect(style!.width).toBeGreaterThan(180);
  });

  it("returns null without a usable bbox or image size", () => {
    expect(faceCropStyle(null, 1000, 1000, 180)).toBeNull();
    expect(
      faceCropStyle({ x: 0, y: 0, w: 0.2, h: 0.2 }, null, 1000, 180)
    ).toBeNull();
    expect(
      faceCropStyle({ x: 0, y: 0, w: 0, h: 0.2 }, 1000, 1000, 180)
    ).toBeNull();
  });

  it("never distorts aspect ratio: rendered width/height match the source image", () => {
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
