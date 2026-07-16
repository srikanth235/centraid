// Framed remote-blob seal format (issue #405 §1 "chunked/rangeable seal").
//
// The old remote seal (issue #296) was a single whole-blob AES-GCM envelope:
// any Range on a `remote-only` blob had to fetch AND unseal the ENTIRE object
// in RAM before a single byte could be served (custody.ts:176-186). A phone
// scrolling onto one cold 40 MiB video paid 40 MiB of download + unseal to
// show a poster frame. This module replaces that envelope with a FRAMED
// format: the plaintext is cut into fixed-size frames, each frame is
// independently sealed, and a footer directory records where every sealed
// frame landed — so a ranged read fetches (trailer + directory + only the
// frames covering the requested bytes) and never the whole object.
//
// Wire layout (all integers big-endian):
//
//   [ header      ] magic (4) | version (1) | plaintext sha (32) = 37 bytes
//   [ frame 0     ] nonce (12) | ciphertext | tag (16)
//   [ frame 1     ] ...
//   [ frame N-1   ]
//   [ directory   ] a SEALED blob: nonce | ct | tag; the plaintext is
//                   frameSize (4) | totalSize (8) | frameCount (4) |
//                   sealedLen[0..N-1] (4 each)
//   [ trailer     ] magic "CBSF" (4) | version (1) | dirLen (4) |
//                   frameCount (4)                                = 13 bytes
//
// A reader does: HEAD → size S; GET suffix [S-13, S) → trailer → dirLen L,
// frameCount N; GET [S-13-L, S-13) → directory → frameSize, totalSize, the
// per-frame sealed lengths (hence each frame's byte offset); then GET only
// the covering frames. The directory is the streaming seal's natural friend:
// the writer accumulates sealed lengths as it emits frames and flushes the
// directory + trailer at the end, so `sealBlobStream` never buffers more than
// a single frame's plaintext.
//
// Integrity binding (issue #405 §1 — frames can't be reordered, truncated, or
// transplanted): every frame's AAD binds `blob:<sha>`, the format version,
// the frame index, AND the total frame count — so frame 3-of-5 of blob A can
// never be replayed as frame 3-of-5 of blob B, as frame 2, or into a 4-frame
// object. The directory's own AAD binds `blob:<sha>`, the version and the
// frame count, so the map of where frames live is as tamper-evident as the
// frames themselves. A partial (ranged) read can't recompute the whole-blob
// sha, so per-frame GCM+AAD IS the integrity story for partial reads — the
// covering frames each authenticate against their pinned (sha, index, count).
//
// v0 pre-release (centraid-v0-status): NO backward compatibility. Objects
// sealed by the pre-#405 whole-blob envelope are NOT readable by this format
// and are expected to be re-sealed by the next replication sweep; there is no
// dual-format reader on purpose.

import {
  CBSF_HEADER_BYTES,
  CBSF_MAGIC,
  CBSF_TRAILER_BYTES,
  CBSF_VERSION,
  cbsfDirectoryAad,
  cbsfFrameAad,
  decodeCbsfDirectory,
  encodeCbsfDirectory,
} from '@centraid/blob-format';
import { createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import * as zlib from 'node:zlib';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Format magic — "Centraid Blob Sealed Frames". */
const MAGIC = Buffer.from(CBSF_MAGIC, 'ascii');
/** Bumped whenever the wire layout changes; bound into every AAD. */
export const SEAL_VERSION = CBSF_VERSION;

/** Fixed header: magic (4) + version (1) + raw plaintext SHA-256 (32). */
export const HEADER_BYTES = CBSF_HEADER_BYTES;
/** Fixed trailer: magic (4) + version (1) + dirLen (4) + frameCount (4). */
export const TRAILER_BYTES = CBSF_TRAILER_BYTES;

/**
 * Default plaintext frame size: 4 MiB. The trade-off (issue #405 §1) is frame
 * count × per-frame GCM overhead (28 bytes: 12 nonce + 16 tag, + 1 algo id +
 * 4 directory bytes ≈ 33 bytes/frame) against range granularity — a ranged
 * read must fetch whole frames, so a byte at offset 0 of a 4 GiB blob costs
 * one 4 MiB frame download, not 4 GiB. 4 MiB keeps the directory tiny (a
 * 4 GiB blob = 1024 frames = ~4 KiB of directory) while capping the
 * read-amplification of a small ranged read at 4 MiB. Tests inject a much
 * smaller frame size so they never allocate multi-MiB buffers.
 */
export const DEFAULT_FRAME_SIZE = 4 * 1024 * 1024;

/** Per-frame compression algorithm id, stored as the first plaintext byte. */
export const ALGO_STORE = 0x00;
export const ALGO_ZSTD = 0x01;
export const ALGO_DEFLATE = 0x02;

// zstd landed in node:zlib (Bun 1.3.13 / Node 22.22) but we feature-detect so
// this never hard-depends on a runtime that lacks it — the deflate-raw path
// (id 0x02) is the fallback. The READER handles all three ids regardless of
// which the writer's runtime chose, so a mixed fleet interops.
const zstdCompress = (zlib as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;
const zstdDecompress = (zlib as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;

/** AAD pinning one frame to its blob, version, index and the total count. */
function frameAad(sha: string, index: number, frameCount: number): Buffer {
  return Buffer.from(cbsfFrameAad(sha, index, frameCount), 'utf8');
}

/** AAD pinning the directory to its blob, version and frame count. */
function dirAad(sha: string, frameCount: number): Buffer {
  return Buffer.from(cbsfDirectoryAad(sha, frameCount), 'utf8');
}

/**
 * Retry-stable nonce derivation for durable multipart uploads. A content key
 * belongs to exactly one plaintext sha, and every frame/directory label is
 * distinct under that key, so HMAC-derived 96-bit nonces remain unique while
 * making a re-seal byte-identical after a crash. That lets already-confirmed
 * provider parts coexist safely with newly generated parts on resume.
 */
function nonceFor(key: Buffer, aad: Buffer, plaintext: Buffer): Buffer {
  return (
    createHmac('sha256', key)
      .update('cbsf-nonce\0')
      .update(aad)
      // A sha can legitimately be sealed by both the store-only streaming path
      // and the compressed outbox path. Binding the actual AEAD plaintext keeps
      // those encryptions retry-stable without ever reusing a GCM nonce for
      // different bytes under the same content key.
      .update('\0')
      .update(createHmac('sha256', key).update(plaintext).digest())
      .digest()
      .subarray(0, NONCE_BYTES)
  );
}

/**
 * Entropy-gated compression (issue #405 §1): try the runtime's best codec and
 * keep the result ONLY if it actually shrank the frame — already-compressed
 * media (JPEG, MP4, zip) is incompressible, so paying the CPU AND storing a
 * larger payload would be pure loss. The chosen algorithm id rides as the
 * frame's first plaintext byte, INSIDE the seal, so it leaks nothing at rest.
 * Identity/dedup is unaffected: compression happens per-frame after the blob's
 * raw-bytes sha is already fixed, so `blob:` addresses never move.
 */
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
  // Keep-if-smaller gate — a tie or a loss stores the raw bytes verbatim.
  if (packed.length < plain.length) return { algoId, payload: packed };
  return { algoId: ALGO_STORE, payload: plain };
}

/** Inverse of `compressFrame`; handles every id regardless of writer runtime. */
function decompressFrame(algoId: number, payload: Buffer): Buffer {
  switch (algoId) {
    case ALGO_STORE:
      return payload;
    case ALGO_ZSTD:
      if (!zstdDecompress) throw new Error('sealed frame uses zstd but this runtime lacks it');
      return zstdDecompress(payload);
    case ALGO_DEFLATE:
      return zlib.inflateRawSync(payload);
    default:
      throw new Error(`unknown frame compression algorithm ${algoId}`);
  }
}

/** Header identity is checked before any frame is trusted. */
export function encodeHeader(sha: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('sealed blob: invalid header sha');
  return Buffer.concat([MAGIC, Buffer.from([SEAL_VERSION]), Buffer.from(sha, 'hex')]);
}

function assertMagicVersion(buf: Buffer): void {
  if (buf.length < MAGIC.length + 1 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('sealed blob: bad magic (not a framed seal, or truncated)');
  }
  if (buf[MAGIC.length] !== SEAL_VERSION) {
    throw new Error(`sealed blob: unsupported version ${buf[MAGIC.length]}`);
  }
}

/** Decode and optionally pin the AEAD-bound plaintext identity in the header. */
export function decodeHeader(buf: Buffer, expectedSha?: string): { sha256: string } {
  if (buf.length < HEADER_BYTES) throw new Error('sealed blob: truncated header');
  assertMagicVersion(buf);
  const sha256 = buf.subarray(MAGIC.length + 1, HEADER_BYTES).toString('hex');
  if (expectedSha !== undefined && sha256 !== expectedSha) {
    throw new Error(`sealed blob: header sha mismatch (expected ${expectedSha}, got ${sha256})`);
  }
  return { sha256 };
}

/**
 * Seal one plaintext frame: compress-if-smaller, prepend the algo id, then
 * AES-256-GCM under `key` with the index/count-binding AAD. Wire shape per
 * frame is `nonce(12) | ciphertext | tag(16)`.
 */
export function sealFrame(
  key: Buffer,
  sha: string,
  index: number,
  frameCount: number,
  plain: Buffer,
): Buffer {
  const { algoId, payload } = compressFrame(plain);
  return sealFramePayload(key, sha, index, frameCount, algoId, payload);
}

/** Store-only twin used by resumable plaintext→provider multipart sessions. */
export function sealStoredFrame(
  key: Buffer,
  sha: string,
  index: number,
  frameCount: number,
  plain: Buffer,
): Buffer {
  return sealFramePayload(key, sha, index, frameCount, ALGO_STORE, plain);
}

function sealFramePayload(
  key: Buffer,
  sha: string,
  index: number,
  frameCount: number,
  algoId: number,
  payload: Buffer,
): Buffer {
  const body = Buffer.concat([Buffer.from([algoId]), payload]);
  const aad = frameAad(sha, index, frameCount);
  const nonce = nonceFor(key, aad, body);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

/** Inverse of `sealFrame`; GCM verification throws on any tamper. */
export function unsealFrame(
  key: Buffer,
  sha: string,
  index: number,
  frameCount: number,
  sealed: Buffer,
): Buffer {
  if (sealed.length < NONCE_BYTES + TAG_BYTES + 1) throw new Error('sealed frame truncated');
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const ct = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(frameAad(sha, index, frameCount));
  decipher.setAuthTag(tag);
  const body = Buffer.concat([decipher.update(ct), decipher.final()]);
  return decompressFrame(body[0]!, body.subarray(1));
}

/**
 * Seal the footer directory: the per-frame sealed lengths plus the frame size
 * and total plaintext size a reader needs to map a byte offset to a frame.
 * Sealed under its own AAD so the map is as tamper-evident as the frames.
 */
export function sealDirectory(
  key: Buffer,
  sha: string,
  frameCount: number,
  frameSize: number,
  totalSize: number,
  sealedLens: number[],
): Buffer {
  const plain = Buffer.from(encodeCbsfDirectory(frameSize, totalSize, sealedLens));
  const aad = dirAad(sha, frameCount);
  const nonce = nonceFor(key, aad, plain);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

export interface FrameDirectory {
  frameSize: number;
  totalSize: number;
  frameCount: number;
  /** Sealed byte length of each frame, in order. */
  sealedLens: number[];
  /** Absolute byte offset of each frame within the object (header-relative). */
  offsets: number[];
}

/** Inverse of `sealDirectory`; verifies the count matches the trailer's. */
export function openDirectory(
  key: Buffer,
  sha: string,
  frameCount: number,
  sealed: Buffer,
): FrameDirectory {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new Error('sealed directory truncated');
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const ct = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(dirAad(sha, frameCount));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  const { frameSize, totalSize, sealedLens } = decodeCbsfDirectory(plain, frameCount);
  const offsets: number[] = [];
  let cursor = HEADER_BYTES;
  for (const len of sealedLens) {
    offsets.push(cursor);
    cursor += len;
  }
  return { frameSize, totalSize, frameCount, sealedLens, offsets };
}

/** The fixed trailer: magic, version, directory byte-length, frame count. */
export function encodeTrailer(directoryLength: number, frameCount: number): Buffer {
  const buf = Buffer.alloc(TRAILER_BYTES);
  MAGIC.copy(buf, 0);
  buf[MAGIC.length] = SEAL_VERSION;
  buf.writeUInt32BE(directoryLength, MAGIC.length + 1);
  buf.writeUInt32BE(frameCount, MAGIC.length + 5);
  return buf;
}

export function decodeTrailer(buf: Buffer): { directoryLength: number; frameCount: number } {
  assertMagicVersion(buf); // magic + version live at the trailer's front too
  return {
    directoryLength: buf.readUInt32BE(MAGIC.length + 1),
    frameCount: buf.readUInt32BE(MAGIC.length + 5),
  };
}

/** Number of fixed-size frames a plaintext of `totalSize` bytes cuts into. */
export function frameCountFor(totalSize: number, frameSize: number): number {
  return totalSize === 0 ? 0 : Math.ceil(totalSize / frameSize);
}

/**
 * The contiguous frame indices whose plaintext spans cover `[start, end]`.
 * Fixed frame size means frame `i` owns plaintext `[i*frameSize, ...)`, so the
 * covering set is a simple index range — no directory walk needed to pick it.
 */
export function coveringFrames(
  frameSize: number,
  start: number,
  end: number,
): { first: number; last: number } {
  return { first: Math.floor(start / frameSize), last: Math.floor(end / frameSize) };
}
