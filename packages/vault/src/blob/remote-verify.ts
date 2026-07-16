import type { BlobStore } from './store.js';
import {
  decodeHeader,
  decodeTrailer,
  HEADER_BYTES,
  openDirectory,
  TRAILER_BYTES,
  unsealFrame,
} from './seal.js';

/** Verify provider identity plus the authenticated directory and first frame. */
export async function verifyRemoteSealedObject(input: {
  store: BlobStore;
  sha256: string;
  key: Buffer;
  sealedSize: number;
  expectedPlaintextSize?: number;
}): Promise<void> {
  const { store, sha256, key, sealedSize, expectedPlaintextSize } = input;
  if (sealedSize < HEADER_BYTES + TRAILER_BYTES)
    throw new Error('provider returned a truncated CBSF object');
  const header = await store.get(sha256, { start: 0, end: HEADER_BYTES - 1 });
  if (!header) throw new Error('provider returned no CBSF header after completion');
  decodeHeader(header, sha256);
  const trailerBytes = await store.get(sha256, {
    start: sealedSize - TRAILER_BYTES,
    end: sealedSize - 1,
  });
  if (!trailerBytes) throw new Error('provider returned no CBSF trailer after completion');
  const trailer = decodeTrailer(trailerBytes);
  const directoryStart = sealedSize - TRAILER_BYTES - trailer.directoryLength;
  if (directoryStart < HEADER_BYTES) throw new Error('provider CBSF directory overruns frames');
  const sealedDirectory = await store.get(sha256, {
    start: directoryStart,
    end: sealedSize - TRAILER_BYTES - 1,
  });
  if (!sealedDirectory) throw new Error('provider returned no CBSF directory after completion');
  const directory = openDirectory(key, sha256, trailer.frameCount, sealedDirectory);
  if (expectedPlaintextSize !== undefined && directory.totalSize !== expectedPlaintextSize) {
    throw new Error(
      `provider CBSF plaintext size mismatch: expected ${expectedPlaintextSize}, got ${directory.totalSize}`,
    );
  }
  const framesEnd =
    HEADER_BYTES + directory.sealedLens.reduce((total, length) => total + length, 0);
  if (framesEnd !== directoryStart) {
    throw new Error(
      `provider CBSF sealed size/layout mismatch: frames end at ${framesEnd}, directory starts at ${directoryStart}`,
    );
  }
  if (directory.frameCount === 0) return;
  const first = await store.get(sha256, {
    start: directory.offsets[0]!,
    end: directory.offsets[0]! + directory.sealedLens[0]! - 1,
  });
  if (!first) throw new Error('provider returned no sampled CBSF frame after completion');
  unsealFrame(key, sha256, 0, directory.frameCount, first);
}
