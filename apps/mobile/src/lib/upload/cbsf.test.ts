// Interop proof: bytes sealed by the device sealer are opened by the VAULT's
// own reader (`packages/vault/src/blob/seal-frames.ts`, node:crypto) and pass
// the same layout assertions `verifyRemoteSealedObject` makes on arrival.
// Importing the real reader — rather than re-deriving the format in a fixture —
// is the point: it is what stops the two implementations drifting.

import { describe, expect, it } from 'vitest';

import {
  decodeHeader,
  decodeTrailer,
  HEADER_BYTES as VAULT_HEADER_BYTES,
  openDirectory,
  SEAL_VERSION as VAULT_SEAL_VERSION,
  TRAILER_BYTES as VAULT_TRAILER_BYTES,
  unsealFrame,
  DEFAULT_FRAME_SIZE,
} from '../../../../../packages/vault/src/blob/seal-frames.js';

import {
  FRAME_BYTES,
  HEADER_BYTES,
  SEAL_VERSION,
  TRAILER_BYTES,
  frameCountFor,
  partCountFor,
  sealDirectory,
  sealPart,
  sealedSizeFor,
} from './cbsf';
import { webCryptoUploadCrypto } from './crypto';
import { IncrementalSha256 } from './incremental-sha256';

const crypto = webCryptoUploadCrypto();
const KEY = new Uint8Array(32).map((_, index) => (index * 7 + 3) & 0xff);

function plaintextOf(size: number): Uint8Array {
  return new Uint8Array(size).map((_, index) => (index * 31 + (index >> 8)) & 0xff);
}

function shaOf(bytes: Uint8Array): string {
  return new IncrementalSha256().update(bytes).digestHex();
}

/** Seal a whole object exactly as the drainer does: directory once, then parts. */
async function sealWholeObject(plain: Uint8Array): Promise<Uint8Array> {
  const sha256 = shaOf(plain);
  const frameCount = frameCountFor(plain.byteLength);
  const directory = await sealDirectory(crypto, KEY, sha256, plain.byteLength, frameCount);
  const parts: Uint8Array[] = [];
  for (let partNumber = 1; partNumber <= partCountFor(frameCount); partNumber += 1) {
    parts.push(
      await sealPart({
        crypto,
        key: KEY,
        sha256,
        plaintextSize: plain.byteLength,
        frameCount,
        partNumber,
        directory,
        read: async (offset, length) => plain.subarray(offset, offset + length),
      }),
    );
  }
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * Re-run the checks `verifyRemoteSealedObject` performs against the provider,
 * using the vault's reader, and return the recovered plaintext.
 */
function vaultUnseal(sealed: Uint8Array, sha256: string, expectedPlaintextSize: number): Buffer {
  const buf = Buffer.from(sealed);
  expect(buf.length).toBeGreaterThanOrEqual(VAULT_HEADER_BYTES + VAULT_TRAILER_BYTES);
  decodeHeader(buf.subarray(0, VAULT_HEADER_BYTES), sha256);
  const trailer = decodeTrailer(buf.subarray(buf.length - VAULT_TRAILER_BYTES));
  const directoryStart = buf.length - VAULT_TRAILER_BYTES - trailer.directoryLength;
  const directory = openDirectory(
    Buffer.from(KEY),
    sha256,
    trailer.frameCount,
    buf.subarray(directoryStart, buf.length - VAULT_TRAILER_BYTES),
  );
  expect(directory.totalSize).toBe(expectedPlaintextSize);
  // The layout assertion that fires if sealedSizeFor/frameSealedLengths drift.
  const framesEnd =
    VAULT_HEADER_BYTES + directory.sealedLens.reduce((total, length) => total + length, 0);
  expect(framesEnd).toBe(directoryStart);
  const frames: Buffer[] = [];
  for (let index = 0; index < directory.frameCount; index += 1) {
    const start = directory.offsets[index]!;
    frames.push(
      unsealFrame(
        Buffer.from(KEY),
        sha256,
        index,
        directory.frameCount,
        buf.subarray(start, start + directory.sealedLens[index]!),
      ),
    );
  }
  return Buffer.concat(frames);
}

describe('CBSF device sealer', () => {
  it('agrees with the vault on the format constants', () => {
    expect(SEAL_VERSION).toBe(VAULT_SEAL_VERSION);
    expect(HEADER_BYTES).toBe(VAULT_HEADER_BYTES);
    expect(TRAILER_BYTES).toBe(VAULT_TRAILER_BYTES);
    expect(FRAME_BYTES).toBe(DEFAULT_FRAME_SIZE);
  });

  // Spans every structural branch: empty, sub-frame, exact frame boundary,
  // multi-frame single part, and an object that spills past one 16 MiB part.
  const sizes = [
    ['empty', 0],
    ['one byte', 1],
    ['sub-frame', 1024],
    ['exactly one frame', FRAME_BYTES],
    ['one frame + 1', FRAME_BYTES + 1],
    ['exactly one part (4 frames)', FRAME_BYTES * 4],
    ['two parts', FRAME_BYTES * 4 + 17],
  ] as const;

  for (const [label, size] of sizes) {
    it(`round-trips ${label} through the vault reader`, async () => {
      const plain = plaintextOf(size);
      const sha256 = shaOf(plain);
      const sealed = await sealWholeObject(plain);

      // The size the gateway was told at `begin` must be what actually landed.
      expect(sealed.byteLength).toBe(sealedSizeFor(size, frameCountFor(size)));

      const recovered = vaultUnseal(sealed, sha256, size);
      expect(recovered.length).toBe(size);
      expect(Buffer.from(plain).equals(recovered)).toBe(true);
    });
  }

  it('seals byte-identically on a re-seal, so a replayed PUT is a no-op', async () => {
    // The property the durable queue leans on: HMAC-derived nonces make a
    // crash-resumed re-seal bit-for-bit identical to what the provider holds.
    const plain = plaintextOf(FRAME_BYTES + 5);
    const first = await sealWholeObject(plain);
    const second = await sealWholeObject(plain);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  it('binds each frame to its index and count', async () => {
    const plain = plaintextOf(FRAME_BYTES + 5);
    const sha256 = shaOf(plain);
    const sealed = Buffer.from(await sealWholeObject(plain));
    const trailer = decodeTrailer(sealed.subarray(sealed.length - VAULT_TRAILER_BYTES));
    const directory = openDirectory(
      Buffer.from(KEY),
      sha256,
      trailer.frameCount,
      sealed.subarray(
        sealed.length - VAULT_TRAILER_BYTES - trailer.directoryLength,
        sealed.length - VAULT_TRAILER_BYTES,
      ),
    );
    const frame0 = sealed.subarray(
      directory.offsets[0]!,
      directory.offsets[0]! + directory.sealedLens[0]!,
    );
    // Replaying frame 0 as frame 1 must fail GCM's AAD check.
    expect(() => unsealFrame(Buffer.from(KEY), sha256, 1, trailer.frameCount, frame0)).toThrow();
  });
});
