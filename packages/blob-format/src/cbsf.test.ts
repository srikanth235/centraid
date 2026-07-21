import { expect, test } from 'vitest';
import {
  CBSF_MAGIC,
  CBSF_VERSION,
  cbsfFrameAad,
  decodeCbsfDirectory,
  encodeCbsfDirectory,
} from './index.js';

test('CBSF magic and version are stable wire constants', () => {
  expect(CBSF_MAGIC).toBe('CBSF');
  expect(CBSF_VERSION).toBe(2);
});

test('frame AAD is deterministic for a given sha/index/count', () => {
  const sha = 'a'.repeat(64);
  expect(cbsfFrameAad(sha, 0, 3)).toBe(`blob:${sha}:v2:f0/3`);
  expect(cbsfFrameAad(sha, 2, 3)).toBe(`blob:${sha}:v2:f2/3`);
});

test('encode/decode CBSF directory round-trips', () => {
  const bytes = encodeCbsfDirectory(1024, 4096, [100, 200, 300]);
  const decoded = decodeCbsfDirectory(bytes, 3);
  expect(decoded.frameSize).toBe(1024);
  expect(decoded.totalSize).toBe(4096);
  expect(decoded.sealedLens).toEqual([100, 200, 300]);
});

test('decodeCbsfDirectory rejects size mismatch', () => {
  expect(() => decodeCbsfDirectory(new Uint8Array(4), 1)).toThrow(/size mismatch/);
});
