// Pins the Hermes-safe SHA-256 against node:crypto. It is not a new algorithm
// and must never behave like one — a drifted digest would re-address every
// blob in the CAS.

import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { IncrementalSha256 } from './incremental-sha256';

function nodeSha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('IncrementalSha256', () => {
  // Sizes chosen around the 64-byte block and the 55/56/64 padding boundaries,
  // where a hand-rolled SHA-256 goes wrong if it goes wrong at all.
  for (const size of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 100_000]) {
    it(`matches node:crypto for ${size} bytes`, () => {
      const bytes = new Uint8Array(randomBytes(size));
      expect(new IncrementalSha256().update(bytes).digestHex()).toBe(nodeSha(bytes));
    });
  }

  it('is independent of how the input is chunked', () => {
    const bytes = new Uint8Array(randomBytes(10_000));
    const expected = nodeSha(bytes);
    for (const stride of [1, 7, 63, 64, 65, 4096]) {
      const hash = new IncrementalSha256();
      for (let offset = 0; offset < bytes.length; offset += stride) {
        hash.update(bytes.subarray(offset, Math.min(bytes.length, offset + stride)));
      }
      expect(hash.digestHex(), `stride ${stride}`).toBe(expected);
    }
  });

  it('does not consume the hash when digested', () => {
    const hash = new IncrementalSha256().update(new Uint8Array([1, 2, 3]));
    const first = hash.digestHex();
    expect(hash.digestHex()).toBe(first);
    hash.update(new Uint8Array([4]));
    expect(hash.digestHex()).toBe(nodeSha(new Uint8Array([1, 2, 3, 4])));
  });
});
