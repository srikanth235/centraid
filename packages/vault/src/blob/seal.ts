// PUBLIC sealers/unsealers (#296, #367 §C8, #405 §1) over the seal-frames.ts
// wire format; ranged reads use those primitives directly.
// Pre-#405 envelopes are NOT readable — stale remotes re-seal next sweep.

import { Transform } from "node:stream";

import {
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
} from "./seal-frames.js";

export {
  decodeHeader,
  decodeTrailer,
  HEADER_BYTES,
  openDirectory,
  TRAILER_BYTES,
  unsealFrame,
} from "./seal-frames.js";
export function sealBlob(
  key: Buffer,
  sha: string,
  plaintext: Buffer,
  frameSize: number = DEFAULT_FRAME_SIZE
): Buffer {
  const frameCount = frameCountFor(plaintext.length, frameSize);
  const parts: Buffer[] = [encodeHeader(sha)];
  const sealedLens: number[] = [];
  for (let i = 0; i < frameCount; i++) {
    const frame = plaintext.subarray(
      i * frameSize,
      Math.min((i + 1) * frameSize, plaintext.length)
    );
    const sealed = sealFrame(key, sha, i, frameCount, frame);
    parts.push(sealed);
    sealedLens.push(sealed.length);
  }
  const dir = sealDirectory(
    key,
    sha,
    frameCount,
    frameSize,
    plaintext.length,
    sealedLens
  );
  parts.push(dir, encodeTrailer(dir.length, frameCount));
  return Buffer.concat(parts);
}

/** Streaming `sealBlob` (#367 §C8, #405 §1): buffers ≤ one frame; totalSize up front fixes the AAD-bound frame count. */
export function sealBlobStream(
  key: Buffer,
  sha: string,
  totalSize: number,
  frameSize: number = DEFAULT_FRAME_SIZE
): Transform {
  const frameCount = frameCountFor(totalSize, frameSize);
  const sealedLens: number[] = [];
  let index = 0;
  let headerSent = false;
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
      while (pendingLen >= frameSize) {
        if (index >= frameCount) break;
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
      const dir = sealDirectory(
        key,
        sha,
        frameCount,
        frameSize,
        totalSize,
        sealedLens
      );
      out.push(dir, encodeTrailer(dir.length, frameCount));
      callback(null, Buffer.concat(out));
    },
  });
}

/** Whole-object unseal (#405); ranged reads never come through here. */
export function unsealBlob(key: Buffer, sha: string, sealed: Buffer): Buffer {
  if (sealed.length < HEADER_BYTES + TRAILER_BYTES)
    throw new Error("sealed blob truncated");
  decodeHeader(sealed.subarray(0, HEADER_BYTES), sha);
  const trailer = decodeTrailer(sealed.subarray(sealed.length - TRAILER_BYTES));
  const dirEnd = sealed.length - TRAILER_BYTES;
  const dirStart = dirEnd - trailer.directoryLength;
  if (dirStart < HEADER_BYTES)
    throw new Error("sealed blob: directory overruns frames");
  const dir = openDirectory(
    key,
    sha,
    trailer.frameCount,
    sealed.subarray(dirStart, dirEnd)
  );
  const frames: Buffer[] = [];
  for (let i = 0; i < dir.frameCount; i++) {
    const start = dir.offsets[i]!;
    const frame = sealed.subarray(start, start + dir.sealedLens[i]!);
    frames.push(unsealFrame(key, sha, i, dir.frameCount, frame));
  }
  return Buffer.concat(frames);
}

// Re-exported for the custody-read.ts ranged read-through and tests.
