import { describe, expect, test } from "vitest";

import { rgbaToThumbHash } from "./thumbhash.js";

/** Solid opaque red 2×2 raster (RGBA). */
function solid(
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
  a = 255
): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = a;
  }
  return out;
}

describe("thumbhash", () => {
  test("rgbaToThumbHash rejects rasters larger than 100×100", () => {
    expect(() => rgbaToThumbHash(101, 10, solid(101, 10, 0, 0, 0))).toThrow(
      /doesn't fit in 100x100/u
    );
    expect(() => rgbaToThumbHash(10, 101, solid(10, 101, 0, 0, 0))).toThrow(
      /doesn't fit in 100x100/u
    );
  });

  test("rgbaToThumbHash encodes a solid color to a stable compact hash", () => {
    const hash = rgbaToThumbHash(8, 8, solid(8, 8, 255, 0, 0));
    expect(hash.length).toBeGreaterThanOrEqual(5);
    expect(hash.length).toBeLessThanOrEqual(25);
    // Same input ⇒ identical bytes (the algorithm is pure).
    expect(
      Buffer.from(rgbaToThumbHash(8, 8, solid(8, 8, 255, 0, 0)))
    ).toStrictEqual(Buffer.from(hash));
  });

  test("rgbaToThumbHash includes alpha channel when the average is not opaque", () => {
    const opaque = rgbaToThumbHash(4, 4, solid(4, 4, 0, 128, 255, 255));
    const translucent = rgbaToThumbHash(4, 4, solid(4, 4, 0, 128, 255, 128));
    // Alpha images produce a longer hash (extra alpha DC/AC terms).
    expect(translucent.length).toBeGreaterThanOrEqual(opaque.length);
  });
});
