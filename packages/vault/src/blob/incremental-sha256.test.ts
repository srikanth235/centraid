import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from 'vitest';
import { IncrementalSha256 } from './incremental-sha256.js';

test('serializable SHA-256 resumes at arbitrary chunk boundaries', () => {
  const bytes = randomBytes(257_321);
  const expected = createHash('sha256').update(bytes).digest('hex');
  let hash = new IncrementalSha256();
  let offset = 0;
  for (const width of [1, 63, 64, 9_999, 17, 65_537, bytes.length]) {
    const end = Math.min(bytes.length, offset + width);
    hash.update(bytes.subarray(offset, end));
    hash = new IncrementalSha256(structuredClone(hash.exportState()));
    offset = end;
    if (offset === bytes.length) break;
  }
  if (offset < bytes.length) hash.update(bytes.subarray(offset));
  expect(hash.digestHex()).toBe(expected);
  // digest is non-destructive: a resumed caller can still append.
  hash.update(Buffer.from('tail'));
  expect(hash.digestHex()).toBe(createHash('sha256').update(bytes).update('tail').digest('hex'));
});

test('SHA-256 matches standard empty and short vectors', () => {
  expect(new IncrementalSha256().digestHex()).toBe(createHash('sha256').digest('hex'));
  expect(new IncrementalSha256().update(Buffer.from('abc')).digestHex()).toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});
