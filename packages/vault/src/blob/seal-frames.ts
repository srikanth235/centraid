// Framed remote-blob seal (#405 §1): a Range on a cold blob fetches only the
// covering frames. Wire layout, integers big-endian:
//
//   [ header    ] magic (4) | version (1) | plaintext sha (32)   = 37 bytes
//   [ frame i   ] nonce (12) | ciphertext | tag (16)
//   [ directory ] SEALED nonce | ct | tag over frameSize (4) |
//                 totalSize (8) | frameCount (4) | sealedLen[i] (4 each)
//   [ trailer   ] magic (4) | version (1) | dirLen (4) | count (4) = 13 bytes
//
// INTEGRITY: each frame's AAD binds `blob:<sha>`, version, frame index AND total
// count, so no frame can be reordered, truncated, or transplanted. A ranged read
// cannot recompute the whole-blob sha, so that AAD is the integrity story.

import { createCipheriv, createDecipheriv, createHmac } from "node:crypto";
import * as zlib from "node:zlib";

import {
  CBSF_HEADER_BYTES,
  CBSF_MAGIC,
  CBSF_TRAILER_BYTES,
  CBSF_VERSION,
  cbsfDirectoryAad,
  cbsfFrameAad,
  decodeCbsfDirectory,
  encodeCbsfDirectory,
} from "@centraid/core/blob";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

const MAGIC = Buffer.from(CBSF_MAGIC, "ascii");
export const SEAL_VERSION = CBSF_VERSION;

export const HEADER_BYTES = CBSF_HEADER_BYTES;
export const TRAILER_BYTES = CBSF_TRAILER_BYTES;

export const DEFAULT_FRAME_SIZE = 4 * 1024 * 1024;

export const ALGO_STORE = 0x00;
export const ALGO_ZSTD = 0x01;
export const ALGO_DEFLATE = 0x02;

// Feature-detected; deflate-raw is the fallback. The READER handles all three
// ids whichever the writer chose.
const zstdCompress = (zlib as { zstdCompressSync?: (b: Buffer) => Buffer })
  .zstdCompressSync;
const zstdDecompress = (zlib as { zstdDecompressSync?: (b: Buffer) => Buffer })
  .zstdDecompressSync;

function frameAad(sha: string, index: number, frameCount: number): Buffer {
  return Buffer.from(cbsfFrameAad(sha, index, frameCount), "utf8");
}

function dirAad(sha: string, frameCount: number): Buffer {
  return Buffer.from(cbsfDirectoryAad(sha, frameCount), "utf8");
}

function nonceFor(key: Buffer, aad: Buffer, plaintext: Buffer): Buffer {
  return (
    createHmac("sha256", key)
      .update("cbsf-nonce\0")
      .update(aad)
      // A sha can be sealed by the store-only and the compressed path both, so
      // bind the plaintext: never reuse a nonce for other bytes.
      .update("\0")
      .update(createHmac("sha256", key).update(plaintext).digest())
      .digest()
      .subarray(0, NONCE_BYTES)
  );
}

/** Keep the codec's output ONLY if it shrank the frame. The algorithm id rides
 *  INSIDE the seal, and the sha is fixed, so addresses never move. */
function compressFrame(plain: Buffer): { algoId: number; payload: Buffer } {
  if (plain.length === 0) return { algoId: ALGO_STORE, payload: plain };
  let algoId: number;
  let packed: Buffer;
  if (zstdCompress) {
    algoId = ALGO_ZSTD;
    packed = zstdCompress(plain);
  } else {
    algoId = ALGO_DEFLATE;
    packed = zlib.deflateRawSync(plain);
  }
  if (packed.length < plain.length) return { algoId, payload: packed };
  return { algoId: ALGO_STORE, payload: plain };
}

function decompressFrame(algoId: number, payload: Buffer): Buffer {
  switch (algoId) {
    case ALGO_STORE:
      return payload;
    case ALGO_ZSTD:
      if (!zstdDecompress)
        throw new Error("sealed frame uses zstd but this runtime lacks it");
      return zstdDecompress(payload);
    case ALGO_DEFLATE:
      return zlib.inflateRawSync(payload);
    default:
      throw new Error(`unknown frame compression algorithm ${algoId}`);
  }
}

export function encodeHeader(sha: string): Buffer {
  if (!/^[0-9a-f]{64}$/u.test(sha))
    throw new Error("sealed blob: invalid header sha");
  return Buffer.concat([
    MAGIC,
    Buffer.from([SEAL_VERSION]),
    Buffer.from(sha, "hex"),
  ]);
}

function assertMagicVersion(buf: Buffer): void {
  if (
    buf.length < MAGIC.length + 1 ||
    !buf.subarray(0, MAGIC.length).equals(MAGIC)
  ) {
    throw new Error("sealed blob: bad magic (not a framed seal, or truncated)");
  }
  if (buf[MAGIC.length] !== SEAL_VERSION) {
    throw new Error(`sealed blob: unsupported version ${buf[MAGIC.length]}`);
  }
}

export function decodeHeader(
  buf: Buffer,
  expectedSha?: string
): { sha256: string } {
  if (buf.length < HEADER_BYTES)
    throw new Error("sealed blob: truncated header");
  assertMagicVersion(buf);
  const sha256 = buf.subarray(MAGIC.length + 1, HEADER_BYTES).toString("hex");
  if (expectedSha !== undefined && sha256 !== expectedSha) {
    throw new Error(
      `sealed blob: header sha mismatch (expected ${expectedSha}, got ${sha256})`
    );
  }
  return { sha256 };
}

export function sealFrame(
  key: Buffer,
  sha: string,
  index: number,
  frameCount: number,
  plain: Buffer
): Buffer {
  const { algoId, payload } = compressFrame(plain);
  return sealFramePayload(key, sha, index, frameCount, algoId, payload);
}

export function sealStoredFrame(
  key: Buffer,
  sha: string,
  index: number,
  frameCount: number,
  plain: Buffer
): Buffer {
  return sealFramePayload(key, sha, index, frameCount, ALGO_STORE, plain);
}

function sealFramePayload(
  key: Buffer,
  sha: string,
  index: number,
  frameCount: number,
  algoId: number,
  payload: Buffer
): Buffer {
  const body = Buffer.concat([Buffer.from([algoId]), payload]);
  const aad = frameAad(sha, index, frameCount);
  const nonce = nonceFor(key, aad, body);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

export function unsealFrame(
  key: Buffer,
  sha: string,
  index: number,
  frameCount: number,
  sealed: Buffer
): Buffer {
  if (sealed.length < NONCE_BYTES + TAG_BYTES + 1)
    throw new Error("sealed frame truncated");
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const ct = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(frameAad(sha, index, frameCount));
  decipher.setAuthTag(tag);
  const body = Buffer.concat([decipher.update(ct), decipher.final()]);
  return decompressFrame(body[0]!, body.subarray(1));
}

/** Sealed under its own AAD: as tamper-evident as the frames it maps. */
export function sealDirectory(
  key: Buffer,
  sha: string,
  frameCount: number,
  frameSize: number,
  totalSize: number,
  sealedLens: number[]
): Buffer {
  const plain = Buffer.from(
    encodeCbsfDirectory(frameSize, totalSize, sealedLens)
  );
  const aad = dirAad(sha, frameCount);
  const nonce = nonceFor(key, aad, plain);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

export interface FrameDirectory {
  frameSize: number;
  totalSize: number;
  frameCount: number;
  sealedLens: number[];
  offsets: number[];
}

export function openDirectory(
  key: Buffer,
  sha: string,
  frameCount: number,
  sealed: Buffer
): FrameDirectory {
  if (sealed.length < NONCE_BYTES + TAG_BYTES)
    throw new Error("sealed directory truncated");
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const ct = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(dirAad(sha, frameCount));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  const { frameSize, totalSize, sealedLens } = decodeCbsfDirectory(
    plain,
    frameCount
  );
  const offsets: number[] = [];
  let cursor = HEADER_BYTES;
  for (const len of sealedLens) {
    offsets.push(cursor);
    cursor += len;
  }
  return { frameSize, totalSize, frameCount, sealedLens, offsets };
}

export function encodeTrailer(
  directoryLength: number,
  frameCount: number
): Buffer {
  const buf = Buffer.alloc(TRAILER_BYTES);
  MAGIC.copy(buf, 0);
  buf[MAGIC.length] = SEAL_VERSION;
  buf.writeUInt32BE(directoryLength, MAGIC.length + 1);
  buf.writeUInt32BE(frameCount, MAGIC.length + 5);
  return buf;
}

export function decodeTrailer(buf: Buffer): {
  directoryLength: number;
  frameCount: number;
} {
  assertMagicVersion(buf); // magic + version live at the trailer's front too
  return {
    directoryLength: buf.readUInt32BE(MAGIC.length + 1),
    frameCount: buf.readUInt32BE(MAGIC.length + 5),
  };
}

export function frameCountFor(totalSize: number, frameSize: number): number {
  return totalSize === 0 ? 0 : Math.ceil(totalSize / frameSize);
}

export function coveringFrames(
  frameSize: number,
  start: number,
  end: number
): { first: number; last: number } {
  return {
    first: Math.floor(start / frameSize),
    last: Math.floor(end / frameSize),
  };
}
