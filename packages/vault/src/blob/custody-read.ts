// Remote read-through for framed sealed blobs (#405 §1, §4); coalescing state in BlobCustody's maps.

import {
  coveringFrames,
  decodeTrailer,
  openDirectory,
  TRAILER_BYTES,
  unsealFrame,
} from "./seal-frames.js";
import type { FrameDirectory } from "./seal-frames.js";
import { resolveRange } from "./store.js";
import type { BlobRange, BlobStore } from "./store.js";

/** Whole-object GET, unsealed; caller verifies + promotes so single-flight shares one. */
export async function fetchRemoteWhole(
  store: BlobStore,
  key: Buffer | undefined,
  sha: string,
  unseal: (key: Buffer, sha: string, sealed: Buffer) => Buffer
): Promise<Buffer | null> {
  const raw = await store.get(sha);
  if (raw === null) return null;
  return key ? unseal(key, sha, raw) : raw;
}

/** Footer via two ranged requests; null on raced delete. */
export async function fetchFrameDirectory(
  store: BlobStore,
  key: Buffer,
  sha: string
): Promise<FrameDirectory | null> {
  const stat = await store.stat(sha);
  if (!stat) return null;
  const size = stat.size;
  if (size < TRAILER_BYTES)
    throw new Error(`remote blob ${sha}: object too small to be framed`);
  const trailerBytes = await store.get(sha, { start: size - TRAILER_BYTES });
  if (!trailerBytes) return null;
  const { directoryLength, frameCount } = decodeTrailer(trailerBytes);
  const dirStart = size - TRAILER_BYTES - directoryLength;
  const dirBytes = await store.get(sha, {
    start: dirStart,
    end: size - TRAILER_BYTES - 1,
  });
  if (!dirBytes) return null;
  return openDirectory(key, sha, frameCount, dirBytes);
}

/** Range via ONLY covering frames; never promotes (partial read can't verify the whole-blob sha); dir pre-fetched for caller coalescing. */
export async function fetchRemoteRange(
  store: BlobStore,
  key: Buffer,
  sha: string,
  range: BlobRange,
  dir: FrameDirectory
): Promise<Buffer | null> {
  const resolved = resolveRange(dir.totalSize, range);
  if (!resolved) return null;
  if (dir.frameCount === 0) return Buffer.alloc(0);
  const { first, last } = coveringFrames(
    dir.frameSize,
    resolved.start,
    resolved.end
  );
  const plaintextParts = await Promise.all(
    Array.from({ length: last - first + 1 }, async (_, index) => {
      const frameIndex = first + index;
      const offset = dir.offsets[frameIndex]!;
      const sealedLen = dir.sealedLens[frameIndex]!;
      const sealed = await store.get(sha, {
        start: offset,
        end: offset + sealedLen - 1,
      });
      return sealed
        ? unsealFrame(key, sha, frameIndex, dir.frameCount, sealed)
        : null;
    })
  );
  if (plaintextParts.some((part) => part === null)) return null; // raced a delete mid-range
  const covered = Buffer.concat(
    plaintextParts.filter((part): part is Buffer => part !== null)
  );
  const sliceStart = resolved.start - first * dir.frameSize;
  const sliceEnd = resolved.end - first * dir.frameSize;
  return covered.subarray(sliceStart, sliceEnd + 1);
}
