// Framed seal format (issue #405 §1): whole-object round-trips across the
// frame-boundary sizes, entropy-gated compression mixing compressible and
// incompressible frames in one blob, and tamper-evidence — a flipped byte, a
// swapped frame, or a truncated directory must all fail closed.

import { randomBytes } from 'node:crypto';
import { expect, test } from 'vitest';
import { sealBlob, sealBlobStream, unsealBlob } from './seal.js';
import {
  HEADER_BYTES,
  sealDirectory,
  sealFrame,
  sealStoredFrame,
  TRAILER_BYTES,
  unsealFrame,
} from './seal-frames.js';
import { sha256OfBytes } from './store.js';
import { Readable } from 'node:stream';

const KEY = Buffer.alloc(32, 0x5a);
const FRAME = 32; // tiny frames so tests never allocate multi-MiB buffers

function roundTrip(plain: Buffer, frameSize = FRAME): Buffer {
  const sha = sha256OfBytes(plain);
  return unsealBlob(KEY, sha, sealBlob(KEY, sha, plain, frameSize));
}

test('framed seal round-trips across every frame-boundary size', () => {
  const sizes = [0, 1, FRAME - 1, FRAME, FRAME + 1, FRAME * 3, FRAME * 3 + 7];
  for (const n of sizes) {
    const plain = randomBytes(n);
    expect(roundTrip(plain).equals(plain)).toBe(true);
  }
});

test('empty blob seals to a header + empty directory + trailer and reads back empty', () => {
  const sha = sha256OfBytes(Buffer.alloc(0));
  const sealed = sealBlob(KEY, sha, Buffer.alloc(0), FRAME);
  expect(sealed.length).toBeGreaterThanOrEqual(HEADER_BYTES + TRAILER_BYTES);
  expect(unsealBlob(KEY, sha, sealed).length).toBe(0);
});

test('entropy gate: compressible and incompressible frames coexist in one blob', () => {
  // Frame 0 all-zeros (compresses hard), frame 1 random (stored verbatim).
  const zeros = Buffer.alloc(FRAME, 0);
  const noise = randomBytes(FRAME);
  const plain = Buffer.concat([zeros, noise]);
  const sha = sha256OfBytes(plain);
  const sealed = sealBlob(KEY, sha, plain, FRAME);
  // Round-trips byte-exact regardless of which frame compressed.
  expect(unsealBlob(KEY, sha, sealed).equals(plain)).toBe(true);
  // At a realistic frame size (per-frame GCM overhead no longer dominates) an
  // all-zeros blob seals to far less than its plaintext (compression fired);
  // a random blob seals to MORE than its plaintext (stored verbatim + framing
  // overhead — the keep-if-smaller gate declined to grow the payload).
  const big = 4096;
  const zerosSha = sha256OfBytes(Buffer.alloc(big * 4));
  const zerosSealed = sealBlob(KEY, zerosSha, Buffer.alloc(big * 4), big);
  expect(zerosSealed.length).toBeLessThan(big * 4);
  const noiseWhole = randomBytes(big * 4);
  const noiseSha = sha256OfBytes(noiseWhole);
  const noiseSealed = sealBlob(KEY, noiseSha, noiseWhole, big);
  expect(noiseSealed.length).toBeGreaterThan(big * 4);
});

test('tamper: a flipped byte inside a frame fails the GCM tag', () => {
  const plain = randomBytes(FRAME * 3);
  const sha = sha256OfBytes(plain);
  const sealed = sealBlob(KEY, sha, plain, FRAME);
  const bad = Buffer.from(sealed);
  const at = HEADER_BYTES + 20; // somewhere inside frame 0
  bad.writeUInt8(sealed[at]! ^ 0xff, at); // flip a byte
  expect(() => unsealBlob(KEY, sha, bad)).toThrow();
});

test('tamper: a truncated directory fails closed', () => {
  const plain = randomBytes(FRAME * 2);
  const sha = sha256OfBytes(plain);
  const sealed = sealBlob(KEY, sha, plain, FRAME);
  // Drop one byte out of the directory region (just before the trailer): the
  // trailer's dirLen no longer lines up, so the directory GCM open fails.
  const cut = Buffer.concat([
    sealed.subarray(0, sealed.length - TRAILER_BYTES - 1),
    sealed.subarray(sealed.length - TRAILER_BYTES),
  ]);
  expect(() => unsealBlob(KEY, sha, cut)).toThrow();
});

test('tamper: a frame cannot be reordered, re-indexed, or transplanted', () => {
  const sha = sha256OfBytes(randomBytes(64));
  const other = sha256OfBytes(randomBytes(64));
  const frame = sealFrame(KEY, sha, 0, 3, Buffer.from('frame-zero-plaintext'));
  // Correct (sha, index, count) unseals; any drift in the AAD triple throws.
  expect(unsealFrame(KEY, sha, 0, 3, frame).toString()).toBe('frame-zero-plaintext');
  expect(() => unsealFrame(KEY, sha, 1, 3, frame)).toThrow(); // re-indexed
  expect(() => unsealFrame(KEY, sha, 0, 4, frame)).toThrow(); // count changed
  expect(() => unsealFrame(KEY, other, 0, 3, frame)).toThrow(); // transplanted
});

test('compressed and store-only writers never reuse a GCM nonce for different plaintext', () => {
  const plain = Buffer.alloc(4096, 0x61);
  const sha = sha256OfBytes(plain);
  const compressed = sealFrame(KEY, sha, 0, 1, plain);
  const stored = sealStoredFrame(KEY, sha, 0, 1, plain);
  expect(compressed.subarray(0, 12).equals(stored.subarray(0, 12))).toBe(false);
  expect(unsealFrame(KEY, sha, 0, 1, compressed).equals(plain)).toBe(true);
  expect(unsealFrame(KEY, sha, 0, 1, stored).equals(plain)).toBe(true);

  const directoryA = sealDirectory(KEY, sha, 1, 4096, 4096, [compressed.length]);
  const directoryB = sealDirectory(KEY, sha, 1, 4096, 4096, [stored.length]);
  expect(directoryA.subarray(0, 12).equals(directoryB.subarray(0, 12))).toBe(false);
});

test('streaming seal matches the buffered seal end-to-end', async () => {
  const plain = randomBytes(FRAME * 4 + 11);
  const sha = sha256OfBytes(plain);
  // Feed the plaintext in awkward chunk sizes to exercise the frame carver.
  const chunks = [
    plain.subarray(0, 5),
    plain.subarray(5, FRAME * 2 + 3),
    plain.subarray(FRAME * 2 + 3),
  ];
  const sealer = sealBlobStream(KEY, sha, plain.length, FRAME);
  const out: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    Readable.from(chunks).pipe(sealer);
    sealer.on('data', (c: Buffer) => out.push(c));
    sealer.on('end', resolve);
    sealer.on('error', reject);
  });
  const streamed = Buffer.concat(out);
  expect(unsealBlob(KEY, sha, streamed).equals(plain)).toBe(true);
});

test('sealing is byte-stable so persisted multipart receipts survive a writer restart', () => {
  const plain = randomBytes(FRAME * 5 + 9);
  const sha = sha256OfBytes(plain);
  const first = sealBlob(KEY, sha, plain, FRAME);
  const resumed = sealBlob(KEY, sha, plain, FRAME);
  expect(resumed.equals(first)).toBe(true);
  expect(unsealBlob(KEY, sha, resumed).equals(plain)).toBe(true);
});
