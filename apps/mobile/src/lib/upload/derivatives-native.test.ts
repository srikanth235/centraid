// dhash is pure arithmetic over an RGBA thumbnail. The module also imports the
// native imaging/file stack at the top level, so those are stubbed to let it
// load under node; only the perceptual hash is exercised here.

import { describe, expect, it, vi } from 'vitest';

import { dhash } from './derivatives-native';

vi.mock('expo-file-system', () => ({
  Directory: vi.fn(),
  File: vi.fn(),
  Paths: { document: {} },
}));
vi.mock('expo-image-manipulator', () => ({
  manipulateAsync: vi.fn(),
  SaveFormat: { JPEG: 'jpeg' },
}));
vi.mock('expo-video-thumbnails', () => ({ getThumbnailAsync: vi.fn() }));
vi.mock('../gateway', () => ({ authHeader: () => ({}) }));

/** A grayscale 9×8 RGBA buffer whose columns follow `luma(col)`. */
function grayscale(luma: (col: number) => number): Uint8Array {
  const width = 9;
  const height = 8;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const value = luma(x);
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return data;
}

describe('dhash', () => {
  it('sets every bit when brightness strictly decreases left to right', () => {
    // Each column is brighter than the one to its right ⇒ a > b ⇒ bit 1.
    expect(
      dhash(
        9,
        8,
        grayscale((col) => (8 - col) * 28),
      ),
    ).toBe('ffffffffffffffff');
  });

  it('clears every bit when brightness strictly increases left to right', () => {
    expect(
      dhash(
        9,
        8,
        grayscale((col) => col * 28),
      ),
    ).toBe('0000000000000000');
  });

  it('is deterministic and always 16 hex chars', () => {
    const data = grayscale((col) => (col * 37 + 11) & 0xff);
    const first = dhash(9, 8, data);
    expect(dhash(9, 8, data), 'same input, same hash').toBe(first);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
  });
});
