import sharp from "sharp";
import { describe, expect, test } from "vitest";

import { createNativeImagePreviewCodec } from "./native-codec.js";

async function png(
  w: number,
  h: number,
  r = 200,
  g = 50,
  b = 50
): Promise<Buffer> {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r, g, b } },
  })
    .png()
    .toBuffer();
}

describe("native-codec", () => {
  test("createNativeImagePreviewCodec downscales and thumbhashes a PNG", async () => {
    const codec = createNativeImagePreviewCodec();
    const source = await png(256, 128);
    const out = await codec.downscale(source, "image/png", 64);
    expect(out).toBeTruthy();
    expect(out!.mediaType).toMatch(/^image\//u);
    expect(out!.bytes.length).toBeGreaterThan(10);
    expect(out!.width).toBeLessThanOrEqual(64);
    expect(out!.height).toBeLessThanOrEqual(64);

    const hash = await codec.thumbhash(source, "image/png");
    expect(hash).toBeTypeOf("string");
    expect(hash!.length).toBeGreaterThan(5);
  });

  test("createNativeImagePreviewCodec rejects unsupported media types", async () => {
    const codec = createNativeImagePreviewCodec();
    const source = await png(32, 32);
    await expect(codec.downscale(source, "image/gif", 64)).resolves.toBeNull();
    await expect(codec.thumbhash(source, "image/webp")).resolves.toBeNull();
  });

  test("createNativeImagePreviewCodec returns null for non-image bytes", async () => {
    const codec = createNativeImagePreviewCodec();
    await expect(
      codec.downscale(Buffer.from("not an image"), "image/png", 64)
    ).resolves.toBeNull();
    await expect(
      codec.thumbhash(Buffer.from("nope"), "image/png")
    ).resolves.toBeNull();
  });
});
