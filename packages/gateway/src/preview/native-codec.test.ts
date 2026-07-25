// Native sharp preview codec (issue #545 B7).

import sharp from 'sharp';
import { expect, test } from 'vitest';
import { createNativeImagePreviewCodec } from './native-codec.js';

async function png(w: number, h: number, r = 200, g = 50, b = 50): Promise<Buffer> {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r, g, b } },
  })
    .png()
    .toBuffer();
}

test('createNativeImagePreviewCodec downscales and thumbhashes a PNG', async () => {
  const codec = createNativeImagePreviewCodec();
  const source = await png(256, 128);
  const out = await codec.downscale(source, 'image/png', 64);
  expect(out).toBeTruthy();
  expect(out!.mediaType).toMatch(/^image\//);
  expect(out!.bytes.length).toBeGreaterThan(10);
  expect(out!.width).toBeLessThanOrEqual(64);
  expect(out!.height).toBeLessThanOrEqual(64);

  const hash = await codec.thumbhash(source, 'image/png');
  expect(typeof hash).toBe('string');
  expect(hash!.length).toBeGreaterThan(5);
});

test('createNativeImagePreviewCodec rejects unsupported media types', async () => {
  const codec = createNativeImagePreviewCodec();
  const source = await png(32, 32);
  expect(await codec.downscale(source, 'image/gif', 64)).toBeNull();
  expect(await codec.thumbhash(source, 'image/webp')).toBeNull();
});

test('createNativeImagePreviewCodec returns null for non-image bytes', async () => {
  const codec = createNativeImagePreviewCodec();
  expect(await codec.downscale(Buffer.from('not an image'), 'image/png', 64)).toBeNull();
  expect(await codec.thumbhash(Buffer.from('nope'), 'image/png')).toBeNull();
});
