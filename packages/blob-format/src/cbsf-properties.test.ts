import { describe, expect, test } from 'vitest';
import { fc } from '@centraid/test-kit/fast-check';
import {
  CBSF_VERSION,
  cbsfDirectoryAad,
  cbsfFrameAad,
  decodeCbsfDirectory,
  encodeCbsfDirectory,
} from './index.js';

const sha64: fc.Arbitrary<string> = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((b) => Buffer.from(b).toString('hex'));

/**
 * CBSF wire properties (#532 core expansion).
 *
 * Model: directory encode/decode is bijective for valid inputs; AAD strings
 * are pure functions of (sha, index, count) and must not collide across frames.
 */
describe('CBSF wire property', () => {
  test('directory encode/decode round-trips', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_048_576 }),
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        fc.array(fc.integer({ min: 0, max: 0xffff_ffff }), { minLength: 0, maxLength: 32 }),
        (frameSize, totalSize, sealedLens) => {
          const bytes = encodeCbsfDirectory(frameSize, totalSize, sealedLens);
          const decoded = decodeCbsfDirectory(bytes, sealedLens.length);
          expect(decoded.frameSize).toBe(frameSize);
          expect(decoded.totalSize).toBe(totalSize);
          expect(decoded.sealedLens).toEqual(sealedLens);
        },
      ),
      { numRuns: 48, seed: 53260 },
    );
  });

  test('decode rejects wrong frameCount', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1024 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 20 }),
        (frameSize, totalSize, sealedLens, wrongOffset) => {
          const bytes = encodeCbsfDirectory(frameSize, totalSize, sealedLens);
          const wrongCount = sealedLens.length + 1 + wrongOffset;
          expect(() => decodeCbsfDirectory(bytes, wrongCount)).toThrow();
        },
      ),
      { numRuns: 24, seed: 53261 },
    );
  });

  test('frame AAD embeds version and is injective on index for fixed count', () => {
    fc.assert(
      fc.property(
        sha64,
        fc.integer({ min: 1, max: 64 }),
        fc.integer({ min: 0, max: 63 }),
        fc.integer({ min: 0, max: 63 }),
        (sha, frameCount, i, j) => {
          fc.pre(i < frameCount && j < frameCount && i !== j);
          const a = cbsfFrameAad(sha, i, frameCount);
          const b = cbsfFrameAad(sha, j, frameCount);
          expect(a).toContain(`v${CBSF_VERSION}`);
          expect(a).not.toBe(b);
          expect(a).toBe(`blob:${sha}:v${CBSF_VERSION}:f${i}/${frameCount}`);
        },
      ),
      { numRuns: 32, seed: 53262 },
    );
  });

  test('directory AAD is deterministic and distinct from frame AAD', () => {
    fc.assert(
      fc.property(sha64, fc.integer({ min: 1, max: 64 }), (sha, frameCount) => {
        const dir = cbsfDirectoryAad(sha, frameCount);
        const frame = cbsfFrameAad(sha, 0, frameCount);
        expect(dir).toBe(`blobdir:${sha}:v${CBSF_VERSION}:n${frameCount}`);
        expect(dir).not.toBe(frame);
        expect(cbsfDirectoryAad(sha, frameCount)).toBe(dir);
      }),
      { numRuns: 24, seed: 53263 },
    );
  });

  test('byte length of directory is 16 + 4*frameCount', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4096 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 0, maxLength: 16 }),
        (frameSize, totalSize, sealedLens) => {
          const bytes = encodeCbsfDirectory(frameSize, totalSize, sealedLens);
          expect(bytes.byteLength).toBe(16 + sealedLens.length * 4);
        },
      ),
      { numRuns: 24, seed: 53264 },
    );
  });

  test('decode rejects when encodedCount disagrees even if byte length matches', () => {
    // Craft a directory whose outer length matches `frameCount` but whose
    // internal encodedCount field was written for a different count — kills
    // the `encodedCount !== frameCount` guard mutants.
    const sealedLens = [10, 20, 30];
    const bytes = encodeCbsfDirectory(512, 1024, sealedLens);
    // Reinterpret with a larger frameCount would fail size check first.
    // Instead: keep length for 3 frames, overwrite encodedCount to 2.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(12, 2, false);
    expect(() => decodeCbsfDirectory(bytes, 3)).toThrow(/metadata mismatch/);
  });
});
