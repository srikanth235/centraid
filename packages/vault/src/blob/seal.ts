// Remote-tier blob sealing — the PUBLIC sealers/unsealers (issue #296 seal,
// #367 §C8 streaming, #405 §1 framed/rangeable). The wire format and its
// low-level frame/directory/trailer primitives live in `seal-frames.ts`; this
// module is the whole-object face of that format: `sealBlob` (buffered),
// `sealBlobStream` (streaming, never buffers more than one frame), and
// `unsealBlob` (whole-object unseal). Ranged remote reads use the same
// primitives directly (custody-read.ts) so a Range never has to unseal the
// whole object. Split out of custody.ts purely along the crypto seam so the
// facade stays a facade.
//
// v0 (centraid-v0-status): the pre-#405 whole-blob envelope is NOT readable
// here — no dual-format reader; stale remotes re-seal on the next sweep.

import { Transform } from 'node:stream';
import {
  coveringFrames,
  decodeHeader,
  decodeTrailer,
  DEFAULT_FRAME_SIZE,
  encodeHeader,
  encodeTrailer,
  frameCountFor,
  HEADER_BYTES,
  openDirectory,
  sealDirectory,
  sealFrame,
  TRAILER_BYTES,
  unsealFrame,
} from './seal-frames.js';

/**
 * Buffered framed seal: cut the plaintext into `frameSize` frames, seal each,
 * then append the sealed directory and the fixed trailer. Used by the
 * replication path for blobs small enough to hold whole (issue #405 §1); the
 * streaming twin below handles the large ones.
 */
export function sealBlob(
  key: Buffer,
  sha: string,
  plaintext: Buffer,
  frameSize: number = DEFAULT_FRAME_SIZE,
): Buffer {
  const frameCount = frameCountFor(plaintext.length, frameSize);
  const parts: Buffer[] = [encodeHeader(sha)];
  const sealedLens: number[] = [];
  for (let i = 0; i < frameCount; i++) {
    const frame = plaintext.subarray(
      i * frameSize,
      Math.min((i + 1) * frameSize, plaintext.length),
    );
    const sealed = sealFrame(key, sha, i, frameCount, frame);
    parts.push(sealed);
    sealedLens.push(sealed.length);
  }
  const dir = sealDirectory(key, sha, frameCount, frameSize, plaintext.length, sealedLens);
  parts.push(dir, encodeTrailer(dir.length, frameCount));
  return Buffer.concat(parts);
}

/**
 * Streaming twin of `sealBlob` (issue #367 §C8 + #405 §1): the replication
 * path pipes a blob's plaintext through this so it never holds the whole blob
 * in memory — at most ONE frame's plaintext is buffered at a time. The total
 * plaintext size is required up front (the local tier knows it via `statSync`
 * before it opens the read stream) so the frame COUNT is known before the
 * first frame is sealed — that's what lets each frame's AAD bind the total
 * count while still streaming. Sealed frame lengths accumulate as frames are
 * emitted and the directory + trailer flush at the end.
 */
export function sealBlobStream(
  key: Buffer,
  sha: string,
  totalSize: number,
  frameSize: number = DEFAULT_FRAME_SIZE,
): Transform {
  const frameCount = frameCountFor(totalSize, frameSize);
  const sealedLens: number[] = [];
  let index = 0;
  let headerSent = false;
  // A ring of pending plaintext chunks not yet big enough to fill a frame.
  let pending: Buffer[] = [];
  let pendingLen = 0;

  const header = (): Buffer[] => {
    if (headerSent) return [];
    headerSent = true;
    return [encodeHeader(sha)];
  };
  const emitFrame = (out: Buffer[], frame: Buffer): void => {
    const sealed = sealFrame(key, sha, index, frameCount, frame);
    sealedLens.push(sealed.length);
    index += 1;
    out.push(...header(), sealed);
  };

  return new Transform({
    transform(chunk: Buffer, _enc, callback) {
      pending.push(chunk);
      pendingLen += chunk.length;
      const out: Buffer[] = [];
      // Only carve full frames here; the trailing partial waits for flush.
      while (pendingLen >= frameSize && index < frameCount) {
        const joined = Buffer.concat(pending, pendingLen);
        emitFrame(out, joined.subarray(0, frameSize));
        const rest = joined.subarray(frameSize);
        pending = rest.length ? [rest] : [];
        pendingLen = rest.length;
      }
      callback(null, Buffer.concat(out));
    },
    flush(callback) {
      const out: Buffer[] = [];
      if (pendingLen > 0 && index < frameCount) {
        emitFrame(out, Buffer.concat(pending, pendingLen));
        pending = [];
        pendingLen = 0;
      }
      out.push(...header()); // zero-frame (empty blob) still needs its header
      const dir = sealDirectory(key, sha, frameCount, frameSize, totalSize, sealedLens);
      out.push(dir, encodeTrailer(dir.length, frameCount));
      callback(null, Buffer.concat(out));
    },
  });
}

/**
 * Whole-object unseal (issue #405 §1): parse the trailer, open the directory,
 * then unseal every frame in order and concatenate. Used by the coalesced
 * full read-through (custody-read.ts) which then verifies the whole-blob sha;
 * a RANGED read never comes through here — it fetches only covering frames.
 */
export function unsealBlob(key: Buffer, sha: string, sealed: Buffer): Buffer {
  if (sealed.length < HEADER_BYTES + TRAILER_BYTES) throw new Error('sealed blob truncated');
  decodeHeader(sealed.subarray(0, HEADER_BYTES), sha);
  const trailer = decodeTrailer(sealed.subarray(sealed.length - TRAILER_BYTES));
  const dirEnd = sealed.length - TRAILER_BYTES;
  const dirStart = dirEnd - trailer.directoryLength;
  if (dirStart < HEADER_BYTES) throw new Error('sealed blob: directory overruns frames');
  const dir = openDirectory(key, sha, trailer.frameCount, sealed.subarray(dirStart, dirEnd));
  const frames: Buffer[] = [];
  for (let i = 0; i < dir.frameCount; i++) {
    const start = dir.offsets[i]!;
    const frame = sealed.subarray(start, start + dir.sealedLens[i]!);
    frames.push(unsealFrame(key, sha, i, dir.frameCount, frame));
  }
  return Buffer.concat(frames);
}

// Re-exported for the ranged read-through (custody-read.ts) and tests.
export {
  coveringFrames,
  decodeHeader,
  decodeTrailer,
  frameCountFor,
  openDirectory,
  DEFAULT_FRAME_SIZE,
  HEADER_BYTES,
  TRAILER_BYTES,
  unsealFrame,
};
