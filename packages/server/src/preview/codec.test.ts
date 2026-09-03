import jpegJs from "jpeg-js";
import { PNG } from "pngjs";
import { describe, expect, test } from "vitest";

import { createImagePreviewCodec } from "./codec.js";

const codec = createImagePreviewCodec();

function raster(width: number, height: number): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = (x * 7) % 256;
      data[i + 1] = (y * 13) % 256;
      data[i + 2] = (x + y) % 256;
      data[i + 3] = 255;
    }
  }
  return data;
}

function makeJpeg(width: number, height: number): Buffer {
  return Buffer.from(
    jpegJs.encode({ data: raster(width, height), width, height }, 90).data
  );
}

function makePng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  raster(width, height).copy(png.data);
  return PNG.sync.write(png);
}

function makeDhashPattern(rows: readonly number[]): Buffer {
  const png = new PNG({ width: 9, height: 8 });
  for (const [row, byte] of rows.entries()) {
    let value = 128;
    for (let col = 0; col < 9; col += 1) {
      const offset = (row * 9 + col) * 4;
      png.data[offset] = value;
      png.data[offset + 1] = value;
      png.data[offset + 2] = value;
      png.data[offset + 3] = 255;
      if (col < 8) value += (byte & (1 << (7 - col))) === 0 ? 10 : -10;
    }
  }
  return PNG.sync.write(png);
}

function decodedSize(bytes: Buffer): { width: number; height: number } {
  const img = jpegJs.decode(bytes, { useTArray: true });
  return { width: img.width, height: img.height };
}

describe("codec", () => {
  test("JPEG source downscales to the tiny rung (256 long edge), output is JPEG", async () => {
    const out = await codec.downscale(makeJpeg(1000, 600), "image/jpeg", 256);
    expect(out).not.toBeNull();
    expect(out!.mediaType).toBe("image/jpeg");
    expect(Math.max(out!.width, out!.height)).toBe(256);
    expect(out!.height).toBe(Math.round((256 / 1000) * 600)); // aspect preserved
    expect(decodedSize(out!.bytes)).toStrictEqual({
      width: out!.width,
      height: out!.height,
    });
    expect(out!.bytes.length).toBeGreaterThan(300);
    expect(out!.bytes.length).toBeLessThan(60_000);
  });

  test("PNG source decodes and re-encodes to a JPEG rung", async () => {
    const out = await codec.downscale(makePng(800, 800), "image/png", 256);
    expect(out).not.toBeNull();
    expect(out!.mediaType).toBe("image/jpeg");
    expect(out!.width).toBe(256);
    expect(out!.height).toBe(256);
  });

  test("medium rung (2048) on a smaller source never upscales", async () => {
    const out = await codec.downscale(makeJpeg(1000, 600), "image/jpeg", 2048);
    expect(out).not.toBeNull();
    expect(out!.width).toBe(1000);
    expect(out!.height).toBe(600);
  });

  test("perceptual hash matches the Photos 9x8 left-brighter dHash contract", async () => {
    const pattern = [0x00, 0xff, 0xaa, 0x55, 0x80, 0x01, 0xf0, 0x0f];
    await expect(
      codec.perceptualHash(makeDhashPattern(pattern), "image/png")
    ).resolves.toBe("00ffaa558001f00f");
    await expect(
      codec.perceptualHash(makePng(9, 8), "image/gif")
    ).resolves.toBeNull();
  });

  test("thumbhash encodes a known raster to the exact reference value", async () => {
    const hash = await codec.thumbhash(makePng(64, 64), "image/png");
    expect(hash).toBe("mOkFFwoywEiCh4eGeFiIV4eE0eBXA4sK");
    expect(Buffer.from(hash!, "base64")).toHaveLength(24);
    expect(
      Buffer.from(hash!, "base64").toString("base64").replace(/=+$/u, "")
    ).toBe(hash);
    await expect(codec.thumbhash(makePng(96, 48), "image/png")).resolves.toBe(
      "WQkGJIhABeJzh3dziIVPikSx9w"
    );
    await expect(
      codec.thumbhash(makePng(9, 8), "image/gif")
    ).resolves.toBeNull();
    await expect(
      codec.thumbhash(Buffer.from("definitely not a PNG"), "image/png")
    ).resolves.toBeNull();
  });

  test("the medium rung of a large source is meaningfully bigger than the tiny rung", async () => {
    const src = makeJpeg(2600, 1800);
    const tiny = await codec.downscale(src, "image/jpeg", 256);
    const medium = await codec.downscale(src, "image/jpeg", 2048);
    expect(Math.max(medium!.width, medium!.height)).toBe(2048);
    expect(medium!.bytes.length).toBeGreaterThan(tiny!.bytes.length);
  });

  test("unsupported media types return null (placeholder contract covers them)", async () => {
    const png = makePng(64, 64);
    await expect(codec.downscale(png, "image/gif", 256)).resolves.toBeNull();
    await expect(codec.downscale(png, "image/webp", 256)).resolves.toBeNull();
    await expect(codec.downscale(png, "video/mp4", 256)).resolves.toBeNull();
  });

  test("an input past the dimension cap returns null, never throws", async () => {
    await expect(
      codec.downscale(makePng(13_000, 1), "image/png", 256)
    ).resolves.toBeNull();
  });

  test("corrupt bytes are a miss, not a crash", async () => {
    await expect(
      codec.downscale(Buffer.from("definitely not a PNG"), "image/png", 256)
    ).resolves.toBeNull();
    await expect(
      codec.downscale(Buffer.from([0xff, 0xd8, 0x00, 0x01]), "image/jpeg", 256)
    ).resolves.toBeNull();
    await expect(
      codec.perceptualHash(Buffer.from("definitely not a PNG"), "image/png")
    ).resolves.toBeNull();
  });

  test("a missing native codec falls back to the portable implementation", async () => {
    const fallback = createImagePreviewCodec(async () => {
      throw new Error("native addon unavailable");
    });
    const out = await fallback.downscale(makePng(320, 160), "image/png", 160);

    expect(out).toMatchObject({
      mediaType: "image/jpeg",
      width: 160,
      height: 80,
    });
  });
});
