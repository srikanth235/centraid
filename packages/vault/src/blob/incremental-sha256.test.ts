import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from 'vitest';
import { IncrementalSha256 } from './incremental-sha256.js';

test('serializable WASM SHA-256 resumes at arbitrary chunk boundaries', async () => {
  const bytes = randomBytes(257_321);
  const expected = createHash('sha256').update(bytes).digest('hex');
  let hash = await IncrementalSha256.create();
  let offset = 0;
  for (const width of [1, 63, 64, 9_999, 17, 65_537, bytes.length]) {
    const end = Math.min(bytes.length, offset + width);
    hash.update(bytes.subarray(offset, end));
    hash = await IncrementalSha256.create(structuredClone(hash.exportState()));
    offset = end;
    if (offset === bytes.length) break;
  }
  if (offset < bytes.length) hash.update(bytes.subarray(offset));
  await expect(hash.digestHex()).resolves.toBe(expected);
  // digest is non-destructive: a resumed caller can still append.
  hash.update(Buffer.from('tail'));
  await expect(hash.digestHex()).resolves.toBe(
    createHash('sha256').update(bytes).update('tail').digest('hex'),
  );
});

test('SHA-256 matches standard empty and short vectors', async () => {
  const empty = await IncrementalSha256.create();
  await expect(empty.digestHex()).resolves.toBe(createHash('sha256').digest('hex'));
  const abc = await IncrementalSha256.create();
  abc.update(Buffer.from('abc'));
  await expect(abc.digestHex()).resolves.toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});
