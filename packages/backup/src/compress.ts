/*
 * Framing (FORMAT.md § Chunk payload framing, #405): compression sits INSIDE
 * encryption as `[algo-id][body]`, kept only if strictly smaller, so the
 * worst case is one byte. Identity keys off RAW plaintext — id, nonce and dedup
 * are untouched — and `ZSTD_LEVEL` is pinned so retries re-frame identically.
 * Id bytes are format-normative; every READER decodes all (restores run
 * elsewhere).
 */

import zlib from "node:zlib";

export const ALGO_STORE = 0x00;
export const ALGO_ZSTD = 0x01;
export const ALGO_DEFLATE = 0x02;

const ZSTD_LEVEL = 3;

const zstdCompressSync: typeof zlib.zstdCompressSync | undefined =
  typeof zlib.zstdCompressSync === "function"
    ? zlib.zstdCompressSync
    : undefined;
const zstdDecompressSync: typeof zlib.zstdDecompressSync | undefined =
  typeof zlib.zstdDecompressSync === "function"
    ? zlib.zstdDecompressSync
    : undefined;

export const zstdAvailable =
  zstdCompressSync !== undefined && zstdDecompressSync !== undefined;

function compressBody(plain: Uint8Array): { algo: number; body: Buffer } {
  if (zstdCompressSync) {
    return {
      algo: ALGO_ZSTD,
      body: zstdCompressSync(plain, {
        params: { [zlib.constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL },
      }),
    };
  }
  return { algo: ALGO_DEFLATE, body: zlib.deflateRawSync(plain) };
}

function frameCompressed(
  plain: Uint8Array,
  algo: number,
  body: Buffer
): Uint8Array {
  if (body.length < plain.length) {
    const framed = new Uint8Array(body.length + 1);
    framed[0] = algo;
    framed.set(body, 1);
    return framed;
  }
  const framed = new Uint8Array(plain.length + 1);
  framed[0] = ALGO_STORE;
  framed.set(plain, 1);
  return framed;
}

export function frameChunkPayload(plain: Uint8Array): Uint8Array {
  const { algo, body } = compressBody(plain);
  return frameCompressed(plain, algo, body);
}

export function frameChunkPayloadAsync(plain: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const done =
      (algo: number) =>
      (error: Error | null, body: Buffer): void => {
        if (error) reject(error);
        else resolve(frameCompressed(plain, algo, body));
      };
    if (zstdCompressSync && typeof zlib.zstdCompress === "function") {
      zlib.zstdCompress(
        plain,
        { params: { [zlib.constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL } },
        done(ALGO_ZSTD)
      );
      return;
    }
    zlib.deflateRaw(plain, done(ALGO_DEFLATE));
  });
}

export function unframeChunkPayload(framed: Uint8Array): Uint8Array {
  if (framed.length < 1)
    throw new Error("unframeChunkPayload: empty frame (missing algo id byte)");
  const algo = framed[0]!;
  const body = framed.subarray(1);
  switch (algo) {
    case ALGO_STORE:
      return body;
    case ALGO_ZSTD:
      if (!zstdDecompressSync) {
        throw new Error(
          "unframeChunkPayload: object is zstd-framed (0x01) but this runtime has no " +
            "node:zlib zstd — restore on Node ≥22.15 or Bun ≥1.3"
        );
      }
      return new Uint8Array(zstdDecompressSync(body));
    case ALGO_DEFLATE:
      return new Uint8Array(zlib.inflateRawSync(body));
    default:
      throw new Error(
        `unframeChunkPayload: unknown frame algorithm id 0x${algo.toString(16)}`
      );
  }
}
