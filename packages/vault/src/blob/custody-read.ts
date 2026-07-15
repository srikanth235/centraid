// Remote read-through for framed sealed blobs (issue #405 §1 ranged read, §4
// single-flight). Split out of custody.ts so the facade stays under the
// governance line-cap and the "how do we read a remote frame" logic sits in
// one place. Everything here is stateless per call EXCEPT the in-flight maps,
// which `BlobCustody` owns and passes in — coalescing is per mounted vault.

import {
  coveringFrames,
  decodeTrailer,
  openDirectory,
  TRAILER_BYTES,
  unsealFrame,
  type FrameDirectory,
} from './seal-frames.js';
import { resolveRange, type BlobRange, type BlobStore } from './store.js';

/**
 * Fetch a whole remote object and return its PLAINTEXT (issue #405 §4): one
 * provider GET of the entire object, unsealed whole (or passed through when
 * the tier is unsealed). The caller verifies the whole-blob sha and promotes
 * into the local tier — this only does the I/O + unseal so the single-flight
 * wrapper can share exactly one of these across concurrent readers.
 */
export async function fetchRemoteWhole(
  store: BlobStore,
  key: Buffer | undefined,
  sha: string,
  unseal: (key: Buffer, sha: string, sealed: Buffer) => Buffer,
): Promise<Buffer | null> {
  const raw = await store.get(sha);
  if (raw === null) return null;
  return key ? unseal(key, sha, raw) : raw;
}

/**
 * Read a framed sealed object's footer (issue #405 §1): HEAD for the size, a
 * suffix GET for the fixed trailer, then a GET for exactly the directory. Two
 * small ranged requests — never the whole object. Returns null when the
 * object is absent (a raced delete), so the ranged path can fall back cleanly.
 */
export async function fetchFrameDirectory(
  store: BlobStore,
  key: Buffer,
  sha: string,
): Promise<FrameDirectory | null> {
  const stat = await store.stat(sha);
  if (!stat) return null;
  const size = stat.size;
  if (size < TRAILER_BYTES) throw new Error(`remote blob ${sha}: object too small to be framed`);
  const trailerBytes = await store.get(sha, { start: size - TRAILER_BYTES });
  if (!trailerBytes) return null;
  const { directoryLength, frameCount } = decodeTrailer(trailerBytes);
  const dirStart = size - TRAILER_BYTES - directoryLength;
  const dirBytes = await store.get(sha, { start: dirStart, end: size - TRAILER_BYTES - 1 });
  if (!dirBytes) return null;
  return openDirectory(key, sha, frameCount, dirBytes);
}

/**
 * Serve a byte range of a framed sealed object by fetching ONLY the covering
 * frames (issue #405 §1) — never the whole object, and deliberately NOT
 * promoting into the local tier (a partial read can't verify the whole-blob
 * sha, so caching an unverifiable whole would be wrong; per-frame GCM+AAD is
 * the integrity story for the bytes actually served). The directory is passed
 * in already-fetched so the caller can coalesce it across concurrent ranged
 * readers of the same sha.
 */
export async function fetchRemoteRange(
  store: BlobStore,
  key: Buffer,
  sha: string,
  range: BlobRange,
  dir: FrameDirectory,
): Promise<Buffer | null> {
  const resolved = resolveRange(dir.totalSize, range);
  if (!resolved) return null;
  if (dir.frameCount === 0) return Buffer.alloc(0);
  const { first, last } = coveringFrames(dir.frameSize, resolved.start, resolved.end);
  const plaintextParts: Buffer[] = [];
  for (let i = first; i <= last; i++) {
    const offset = dir.offsets[i]!;
    const sealedLen = dir.sealedLens[i]!;
    const sealed = await store.get(sha, { start: offset, end: offset + sealedLen - 1 });
    if (!sealed) return null; // raced a delete mid-range
    plaintextParts.push(unsealFrame(key, sha, i, dir.frameCount, sealed));
  }
  // The covering frames start at plaintext offset `first * frameSize`; slice
  // the requested window out of that contiguous run.
  const covered = Buffer.concat(plaintextParts);
  const sliceStart = resolved.start - first * dir.frameSize;
  const sliceEnd = resolved.end - first * dir.frameSize;
  return covered.subarray(sliceStart, sliceEnd + 1);
}
