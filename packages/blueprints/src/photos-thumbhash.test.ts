import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

const moduleUrl = pathToFileURL(
  path.resolve(import.meta.dirname, "..", "apps/photos/thumbhash.js")
).href;
const { thumbHashFromRgba } = (await import(moduleUrl)) as {
  thumbHashFromRgba: (w: number, h: number, rgba: Uint8Array) => string | null;
};

function gradient(w: number, h: number): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      data[i] = (x * 7) % 256;
      data[i + 1] = (y * 13) % 256;
      data[i + 2] = (x + y) % 256;
      data[i + 3] = 255;
    }
  }
  return data;
}

describe("photos-thumbhash", () => {
  test("client encoder matches the gateway codec byte-for-byte on the same RGBA", () => {
    expect(thumbHashFromRgba(64, 64, gradient(64, 64))).toBe(
      "mOkFFwoywEiCh4eGeFiIV4eE0eBXA4sK"
    );
    expect(thumbHashFromRgba(96, 48, gradient(96, 48))).toBe(
      "WQkGJIhABeJzh3dziIVPikSx9w"
    );
  });

  test("produces canonical unpadded base64 and refuses inputs over 100 px", () => {
    const hash = thumbHashFromRgba(64, 64, gradient(64, 64))!;
    expect(hash).toMatch(/^[A-Za-z0-9+/]+$/u); // unpadded, standard alphabet
    expect(
      Buffer.from(hash, "base64").toString("base64").replace(/=+$/u, "")
    ).toBe(hash);
    expect(thumbHashFromRgba(200, 10, gradient(1, 1))).toBeNull();
  });
});
