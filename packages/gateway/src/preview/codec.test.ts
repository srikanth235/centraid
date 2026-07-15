// The raster preview codec (issue #405 §2): decode → area-average downscale →
// JPEG re-encode. Fixtures are synthesized with the SAME libraries the codec
// decodes with (jpeg-js / pngjs), so these are true round-trips — encode a
// known-size image, run it through the codec, decode the result and assert the
// resulting dimensions and a rough size band. Plus the boundary behaviors the
// orchestration relies on: no upscaling, and `null` for unsupported / oversize
// / corrupt inputs.

import { expect, test } from 'vitest';
import jpegJs from 'jpeg-js';
import { PNG } from 'pngjs';
import { createImagePreviewCodec } from './codec.js';

const codec = createImagePreviewCodec();

/** A synthesized RGBA raster with a deterministic gradient (never flat — a
 *  flat image compresses to a handful of bytes and hides size regressions). */
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
  return Buffer.from(jpegJs.encode({ data: raster(width, height), width, height }, 90).data);
}

function makePng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  raster(width, height).copy(png.data);
  return PNG.sync.write(png);
}

function decodedSize(bytes: Buffer): { width: number; height: number } {
  const img = jpegJs.decode(bytes, { useTArray: true });
  return { width: img.width, height: img.height };
}

test('JPEG source downscales to the tiny rung (256 long edge), output is JPEG', () => {
  const out = codec.downscale(makeJpeg(1000, 600), 'image/jpeg', 256);
  expect(out).not.toBeNull();
  expect(out!.mediaType).toBe('image/jpeg');
  expect(Math.max(out!.width, out!.height)).toBe(256);
  expect(out!.height).toBe(Math.round((256 / 1000) * 600)); // aspect preserved
  // The reported dims match what the bytes actually decode to.
  expect(decodedSize(out!.bytes)).toEqual({ width: out!.width, height: out!.height });
  // A 256 px JPEG is small but not empty — a loose band that catches gross regressions.
  expect(out!.bytes.length).toBeGreaterThan(300);
  expect(out!.bytes.length).toBeLessThan(60_000);
});

test('PNG source decodes and re-encodes to a JPEG rung', () => {
  const out = codec.downscale(makePng(800, 800), 'image/png', 256);
  expect(out).not.toBeNull();
  expect(out!.mediaType).toBe('image/jpeg');
  expect(out!.width).toBe(256);
  expect(out!.height).toBe(256);
});

test('medium rung (2048) on a smaller source never upscales', () => {
  const out = codec.downscale(makeJpeg(1000, 600), 'image/jpeg', 2048);
  expect(out).not.toBeNull();
  expect(out!.width).toBe(1000); // native size preserved, just re-encoded
  expect(out!.height).toBe(600);
});

// A generous timeout: pure-JS decode/downscale of a multi-MP source is
// hundreds of ms and can stretch under parallel-suite CPU contention (exactly
// why generation is a bounded background backstop, never a request path).
test('the medium rung of a large source is meaningfully bigger than the tiny rung', () => {
  const src = makeJpeg(2600, 1800); // long edge > 2048, so medium truly downscales
  const tiny = codec.downscale(src, 'image/jpeg', 256);
  const medium = codec.downscale(src, 'image/jpeg', 2048);
  expect(Math.max(medium!.width, medium!.height)).toBe(2048);
  expect(medium!.bytes.length).toBeGreaterThan(tiny!.bytes.length);
}, 20_000);

test('unsupported media types return null (placeholder contract covers them)', () => {
  const png = makePng(64, 64);
  expect(codec.downscale(png, 'image/gif', 256)).toBeNull();
  expect(codec.downscale(png, 'image/webp', 256)).toBeNull();
  expect(codec.downscale(png, 'video/mp4', 256)).toBeNull();
});

test('an input past the dimension cap returns null, never throws', () => {
  // 13000 px on one edge is over MAX_INPUT_EDGE — a cheap 13000×1 strip proves
  // the guard fires before any heavy downscale work.
  expect(codec.downscale(makePng(13_000, 1), 'image/png', 256)).toBeNull();
});

test('corrupt bytes are a miss, not a crash', () => {
  expect(codec.downscale(Buffer.from('definitely not a PNG'), 'image/png', 256)).toBeNull();
  expect(codec.downscale(Buffer.from([0xff, 0xd8, 0x00, 0x01]), 'image/jpeg', 256)).toBeNull();
});
