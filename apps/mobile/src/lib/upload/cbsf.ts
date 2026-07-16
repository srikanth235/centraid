// Device-side CBSF v2 edge sealing (#419 M0.4).
//
// The wire format is defined by `packages/vault/src/blob/seal-frames.ts` and
// enforced on arrival by `packages/vault/src/blob/remote-verify.ts`
// (`verifyRemoteSealedObject`). This module is a third writer of that same
// format — after the vault (node:crypto) and the WebView's
// `packages/blueprints/kit/edge-upload.js` (crypto.subtle) — because neither
// is importable from Hermes. `cbsf.test.ts` unseals this module's output with
// the vault's own `unsealFrame`/`openDirectory` so the two can never drift.
//
// Layout (all integers big-endian), quoting seal-frames.ts:
//
//   [ header    ] magic "CBSF" (4) | version (1) | plaintext sha (32) = 37
//   [ frame i   ] nonce (12) | ciphertext | tag (16)
//   [ directory ] SEALED: nonce | ct | tag; plaintext is
//                 frameSize (4) | totalSize (8) | frameCount (4) |
//                 sealedLen[0..N-1] (4 each)
//   [ trailer   ] magic (4) | version (1) | dirLen (4) | frameCount (4) = 13
//
// Two deliberate choices, both interop-safe:
//
//  1. Frames are ALWAYS store-only (algo id 0x00). The algo id rides inside
//     the seal and the vault's reader dispatches on it, so a store-only writer
//     interops with a compressing one. Store-only is what makes `sealedSize`
//     computable BEFORE any byte is read — the gateway needs it at `begin` to
//     mint the multipart plan.
//
//  2. Nonces are HMAC-derived, not random. This follows seal-frames.ts
//     (`nonceFor`), whose comment is load-bearing for us: a content key
//     belongs to exactly one plaintext sha and every frame label is distinct
//     under it, so derived nonces stay unique while making a re-seal
//     BYTE-IDENTICAL after a crash. That is precisely what a resumable
//     multipart upload needs — a re-sealed part is bit-for-bit the part the
//     provider may already hold, so replaying a PUT is a true no-op and
//     confirmed parts can coexist with re-sealed ones. `edge-upload.js` uses a
//     random nonce and forfeits that property; the durable queue does not.

import { concatBytes, hexToBytes, u32be, u64be, utf8 } from './bytes';
import type { UploadCrypto } from './crypto';

const MAGIC = utf8('CBSF');
export const SEAL_VERSION = 2;
export const HEADER_BYTES = 37;
export const TRAILER_BYTES = 13;
const NONCE_BYTES = 12;
const ALGO_STORE = 0x00;

/** Plaintext bytes per sealed frame — must equal seal-frames.ts DEFAULT_FRAME_SIZE. */
export const FRAME_BYTES = 4 * 1024 * 1024;
/** Frames per multipart part, giving the repo's fixed 16 MiB plaintext part. */
export const FRAMES_PER_PART = 4;
/** Plaintext bytes per multipart part. */
export const PART_PLAINTEXT_BYTES = FRAME_BYTES * FRAMES_PER_PART;

export function frameCountFor(plaintextSize: number): number {
  return plaintextSize === 0 ? 0 : Math.ceil(plaintextSize / FRAME_BYTES);
}

export function partCountFor(frameCount: number): number {
  return Math.max(1, Math.ceil(frameCount / FRAMES_PER_PART));
}

/**
 * Sealed size of the whole object, known before reading a byte.
 * header(37) + [plain + 29/frame] + [sealed directory 44 + 4/frame] + trailer(13).
 */
export function sealedSizeFor(plaintextSize: number, frameCount: number): number {
  return plaintextSize + 94 + 33 * frameCount;
}

/** Sealed length of each frame: nonce(12) + algo(1) + plaintext + tag(16). */
export function frameSealedLengths(plaintextSize: number, frameCount: number): number[] {
  return Array.from(
    { length: frameCount },
    (_, index) => Math.min(FRAME_BYTES, plaintextSize - index * FRAME_BYTES) + 29,
  );
}

function frameAad(sha: string, index: number, frameCount: number): Uint8Array {
  return utf8(`blob:${sha}:v${SEAL_VERSION}:f${index}/${frameCount}`);
}

function directoryAad(sha: string, frameCount: number): Uint8Array {
  return utf8(`blobdir:${sha}:v${SEAL_VERSION}:n${frameCount}`);
}

/** Retry-stable nonce derivation — mirrors seal-frames.ts `nonceFor`. */
async function nonceFor(
  crypto: UploadCrypto,
  key: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const mac = await crypto.hmacSha256(key, utf8('cbsf-nonce\0'), aad);
  return mac.subarray(0, NONCE_BYTES);
}

export function encodeHeader(sha: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('sealed blob: invalid header sha');
  return concatBytes([MAGIC, Uint8Array.of(SEAL_VERSION), hexToBytes(sha)]);
}

export function encodeTrailer(directoryLength: number, frameCount: number): Uint8Array {
  return concatBytes([
    MAGIC,
    Uint8Array.of(SEAL_VERSION),
    u32be(directoryLength),
    u32be(frameCount),
  ]);
}

/** Seal one store-only frame: `nonce(12) | ciphertext | tag(16)`. */
export async function sealFrame(
  crypto: UploadCrypto,
  key: Uint8Array,
  sha: string,
  index: number,
  frameCount: number,
  plain: Uint8Array,
): Promise<Uint8Array> {
  const aad = frameAad(sha, index, frameCount);
  const nonce = await nonceFor(crypto, key, aad);
  const sealed = await crypto.sealGcm(
    key,
    nonce,
    aad,
    concatBytes([Uint8Array.of(ALGO_STORE), plain]),
  );
  return concatBytes([nonce, sealed]);
}

/** Seal the footer directory that maps plaintext offsets onto sealed frames. */
export async function sealDirectory(
  crypto: UploadCrypto,
  key: Uint8Array,
  sha: string,
  plaintextSize: number,
  frameCount: number,
): Promise<Uint8Array> {
  const plain = concatBytes([
    u32be(FRAME_BYTES),
    u64be(plaintextSize),
    u32be(frameCount),
    ...frameSealedLengths(plaintextSize, frameCount).map(u32be),
  ]);
  const aad = directoryAad(sha, frameCount);
  const nonce = await nonceFor(crypto, key, aad);
  return concatBytes([nonce, await crypto.sealGcm(key, nonce, aad, plain)]);
}

export interface SealPartInput {
  crypto: UploadCrypto;
  key: Uint8Array;
  sha256: string;
  plaintextSize: number;
  frameCount: number;
  /** 1-based, matching the gateway's part numbering. */
  partNumber: number;
  /** Pre-sealed directory; identical for every part, so seal it once per drain. */
  directory: Uint8Array;
  /** Reads plaintext at an absolute offset. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

/**
 * Assemble one multipart part's sealed bytes. The header rides part 1 and the
 * directory + trailer ride the last part, so parts are NOT uniform 16 MiB —
 * only their plaintext spans are. Frame indices are global across the object
 * (they are bound into each frame's AAD), which is why `frameCount` must be
 * known before any part is sealed.
 */
export async function sealPart(input: SealPartInput): Promise<Uint8Array> {
  const { crypto, key, sha256, plaintextSize, frameCount, partNumber, directory } = input;
  const partIndex = partNumber - 1;
  const first = partIndex * FRAMES_PER_PART;
  const last = Math.min(frameCount, first + FRAMES_PER_PART);
  const body: Uint8Array[] = [];
  if (partIndex === 0) body.push(encodeHeader(sha256));
  for (let index = first; index < last; index += 1) {
    const offset = index * FRAME_BYTES;
    const length = Math.min(FRAME_BYTES, plaintextSize - offset);
    const plain = await input.read(offset, length);
    if (plain.byteLength !== length) {
      throw new Error(`frame ${index} read ${plain.byteLength} bytes, expected ${length}`);
    }
    body.push(await sealFrame(crypto, key, sha256, index, frameCount, plain));
  }
  if (last === frameCount) body.push(directory, encodeTrailer(directory.byteLength, frameCount));
  return concatBytes(body);
}
