// The Photos client ThumbHash encoder (issue #419). A faithful port of the
// same reference the gateway codec uses, so the two agree byte-for-byte on the
// same RGBA — asserted here against the exact fixtures the gateway codec test
// pins. Exercised as a plain module (no kit imports, no canvas) so the pure
// encoder is testable outside the browser.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';

const moduleUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '..', 'apps/photos/thumbhash.js'),
).href;
const { thumbHashFromRgba } = (await import(moduleUrl)) as {
  thumbHashFromRgba: (w: number, h: number, rgba: Uint8Array) => string | null;
};

/** The same deterministic gradient the gateway codec test rasters. */
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

test('client encoder matches the gateway codec byte-for-byte on the same RGBA', () => {
  // Identical fixtures to packages/gateway/src/preview/codec.test.ts — client
  // and gateway are the same reference algorithm, so a photo staged at upload
  // and one filled by the backstop carry the same placeholder.
  expect(thumbHashFromRgba(64, 64, gradient(64, 64))).toBe('mOkFFwoywEiCh4eGeFiIV4eE0eBXA4sK');
  expect(thumbHashFromRgba(96, 48, gradient(96, 48))).toBe('WQkGJIhABeJzh3dziIVPikSx9w');
});

test('produces canonical unpadded base64 and refuses inputs over 100 px', () => {
  const hash = thumbHashFromRgba(64, 64, gradient(64, 64))!;
  expect(hash).toMatch(/^[A-Za-z0-9+/]+$/); // unpadded, standard alphabet
  expect(Buffer.from(hash, 'base64').toString('base64').replace(/=+$/, '')).toBe(hash);
  // ThumbHash caps at 100×100 — callers downscale first; a raw over-size input
  // is refused (null), never a throw that could sink an upload.
  expect(thumbHashFromRgba(200, 10, gradient(1, 1))).toBeNull();
});
