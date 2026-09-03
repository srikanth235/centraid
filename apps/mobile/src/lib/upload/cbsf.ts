import { concatBytes, hexToBytes, u32be, u64be, utf8 } from "./bytes";
import type { UploadCrypto } from "./crypto";

const MAGIC = utf8("CBSF");
export const SEAL_VERSION = 2;
export const HEADER_BYTES = 37;
export const TRAILER_BYTES = 13;
const NONCE_BYTES = 12;
const ALGO_STORE = 0x00;

export const FRAME_BYTES = 4 * 1024 * 1024;
export const FRAMES_PER_PART = 4;
export function frameCountFor(plaintextSize: number): number {
  return plaintextSize === 0 ? 0 : Math.ceil(plaintextSize / FRAME_BYTES);
}

export function partCountFor(frameCount: number): number {
  return Math.max(1, Math.ceil(frameCount / FRAMES_PER_PART));
}

export function sealedSizeFor(
  plaintextSize: number,
  frameCount: number
): number {
  return plaintextSize + 94 + 33 * frameCount;
}

export function frameSealedLengths(
  plaintextSize: number,
  frameCount: number
): number[] {
  return Array.from(
    { length: frameCount },
    (_, index) =>
      Math.min(FRAME_BYTES, plaintextSize - index * FRAME_BYTES) + 29
  );
}

function frameAad(sha: string, index: number, frameCount: number): Uint8Array {
  return utf8(`blob:${sha}:v${SEAL_VERSION}:f${index}/${frameCount}`);
}

function directoryAad(sha: string, frameCount: number): Uint8Array {
  return utf8(`blobdir:${sha}:v${SEAL_VERSION}:n${frameCount}`);
}

async function nonceFor(
  crypto: UploadCrypto,
  key: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> {
  const mac = await crypto.hmacSha256(key, utf8("cbsf-nonce\0"), aad);
  return mac.subarray(0, NONCE_BYTES);
}

export function encodeHeader(sha: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/u.test(sha))
    throw new Error("sealed blob: invalid header sha");
  return concatBytes([MAGIC, Uint8Array.of(SEAL_VERSION), hexToBytes(sha)]);
}

export function encodeTrailer(
  directoryLength: number,
  frameCount: number
): Uint8Array {
  return concatBytes([
    MAGIC,
    Uint8Array.of(SEAL_VERSION),
    u32be(directoryLength),
    u32be(frameCount),
  ]);
}

export async function sealFrame(
  crypto: UploadCrypto,
  key: Uint8Array,
  sha: string,
  index: number,
  frameCount: number,
  plain: Uint8Array
): Promise<Uint8Array> {
  const aad = frameAad(sha, index, frameCount);
  const nonce = await nonceFor(crypto, key, aad);
  const sealed = await crypto.sealGcm(
    key,
    nonce,
    aad,
    concatBytes([Uint8Array.of(ALGO_STORE), plain])
  );
  return concatBytes([nonce, sealed]);
}

export async function sealDirectory(
  crypto: UploadCrypto,
  key: Uint8Array,
  sha: string,
  plaintextSize: number,
  frameCount: number
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
  partNumber: number;
  directory: Uint8Array;
  read: (offset: number, length: number) => Promise<Uint8Array>;
}

export async function sealPart(input: SealPartInput): Promise<Uint8Array> {
  const {
    crypto,
    key,
    sha256,
    plaintextSize,
    frameCount,
    partNumber,
    directory,
  } = input;
  const partIndex = partNumber - 1;
  const first = partIndex * FRAMES_PER_PART;
  const last = Math.min(frameCount, first + FRAMES_PER_PART);
  const body: Uint8Array[] = [];
  if (partIndex === 0) body.push(encodeHeader(sha256));
  const sealNextFrame = async (index: number): Promise<void> => {
    if (index >= last) return;
    const offset = index * FRAME_BYTES;
    const length = Math.min(FRAME_BYTES, plaintextSize - offset);
    const plain = await input.read(offset, length);
    if (plain.byteLength !== length) {
      throw new Error(
        `frame ${index} read ${plain.byteLength} bytes, expected ${length}`
      );
    }
    body.push(await sealFrame(crypto, key, sha256, index, frameCount, plain));
    return sealNextFrame(index + 1);
  };
  await sealNextFrame(first);
  if (last === frameCount)
    body.push(directory, encodeTrailer(directory.byteLength, frameCount));
  return concatBytes(body);
}
