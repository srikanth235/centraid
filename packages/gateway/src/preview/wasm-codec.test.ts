// WASM vips preview codec (issue #545 B7).

import sharp from 'sharp';
import { expect, test } from 'vitest';
import { createWasmImagePreviewCodec } from './wasm-codec.js';

async function png(w: number, h: number): Promise<Buffer> {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: 40, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
}

test('createWasmImagePreviewCodec downscales and thumbhashes a PNG', async () => {
  const codec = createWasmImagePreviewCodec();
  const source = await png(200, 100);
  const out = await codec.downscale(source, 'image/png', 50);
  expect(out).toBeTruthy();
  expect(out!.bytes.length).toBeGreaterThan(10);
  expect(out!.width).toBeLessThanOrEqual(50);
  expect(out!.height).toBeLessThanOrEqual(50);

  const hash = await codec.thumbhash(source, 'image/png');
  expect(typeof hash).toBe('string');
  expect((hash as string).length).toBeGreaterThan(5);
});

test('createWasmImagePreviewCodec rejects unsupported media types', async () => {
  const codec = createWasmImagePreviewCodec();
  const source = await png(16, 16);
  expect(await codec.downscale(source, 'image/gif', 32)).toBeNull();
});
