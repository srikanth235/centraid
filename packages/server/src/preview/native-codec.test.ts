import { readFileSync } from "node:fs";
import path from "node:path";

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

  // HEIC/HEIF (#1011). iPhones capture HEIC by default, so the codec must at
  // least ADMIT the type: refusing it at the gate meant most of a real phone
  // library never got a preview rung and every recognition recipe read "not
  // ready" for it forever. Admitting it is not the same as decoding it — see
  // the decline test below.
  test("createNativeImagePreviewCodec previews a HEIF-family source", async () => {
    const codec = createNativeImagePreviewCodec();
    // AVIF is HEIF's other coding, and it is what THIS libheif build decodes.
    // A file carrying the `mif1` brand sniffs as `image/heic` in the vault
    // pipeline, so this is the shape the gate has to let through.
    const source = await sharp(await png(256, 128))
      .avif({ quality: 50 })
      .toBuffer();
    const thumb = await codec.downscale(source, "image/heic", 64);
    expect(thumb).toBeTruthy();
    expect(thumb!.mediaType).toBe("image/jpeg");
    expect(thumb!.width).toBeLessThanOrEqual(64);
    const preview = await codec.downscale(source, "image/heif", 1024);
    expect(preview).toBeTruthy();
    expect(preview!.width).toBe(256);
    await expect(codec.thumbhash(source, "image/heic")).resolves.toBeTypeOf(
      "string"
    );
    await expect(codec.perceptualHash(source, "image/heif")).resolves.toMatch(
      /^[0-9a-f]{16}$/u
    );
  });

  // The other half of the contract: a source libheif REFUSES is a decline,
  // never a throw. `hevc-photo.heic` is a real HEVC-coded HEIC (the coding an
  // iPhone writes), and the sharp build this repo pins ships libheif WITHOUT an
  // HEVC decoder — "Support for this compression format has not been built in".
  // The camera-roll sample that opened #1011 declines the same way through a
  // different libheif refusal (its iref box carries 48 references, over the 16
  // the security limit allows). Either way the vault records the durable
  // "preview unsupported" marker and the ambient walk moves on.
  test("createNativeImagePreviewCodec declines an undecodable HEIC", async () => {
    const codec = createNativeImagePreviewCodec();
    const source = readFileSync(
      path.join(import.meta.dirname, "fixtures/hevc-photo.heic")
    );
    await expect(codec.downscale(source, "image/heic", 64)).resolves.toBeNull();
    await expect(
      codec.perceptualHash(source, "image/heic")
    ).resolves.toBeNull();
    await expect(codec.thumbhash(source, "image/heic")).resolves.toBeNull();
  });
});
