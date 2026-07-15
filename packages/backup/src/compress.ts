/*
 * Entropy-gated payload framing (FORMAT.md § Chunk payload framing —
 * centraid-snapshot/2, issue #405 §1).
 *
 * Compression sits INSIDE encryption: the plaintext a chunk object seals is no
 * longer the raw part bytes but a one-byte-tagged frame `[algo-id][body]`. The
 * writer compresses, then keeps the compressed body ONLY if it is strictly
 * smaller than raw (the "keep-if-smaller" gate); otherwise it stores raw under
 * `0x00`. That gate is why incompressible input can never inflate the stored
 * object by more than the single id byte — random bytes always fail the gate
 * and ship as `[0x00][raw]`.
 *
 * Crucially the frame is a property of the SEALED PAYLOAD, not of identity:
 * chunk ids, `blob:` addresses and dedup all key off the RAW plaintext bytes
 * (crypto.ts `chunkId` = HMAC over raw), and the deterministic chunk nonce is
 * derived from that raw-plaintext id too. So whether or not compression kicks
 * in, the same plaintext converges on the same object key and the same nonce —
 * compression changes only how many ciphertext bytes land there. (#405 §1:
 * "identities key off raw plaintext bytes so chunk ids, blob: addresses, and
 * dedup are untouched".)
 *
 * Algorithm choice, and why the reader is broader than the writer: zstd landed
 * in `node:zlib` in Node 22.15 and is present in Bun 1.3.x, so the writer
 * prefers it. But a runtime without zstd must still produce readable backups,
 * so the writer falls back to raw-deflate under its OWN id byte (`0x02`) — and
 * the READER must handle every id byte regardless of what the local writer can
 * emit, because a snapshot is routinely restored on a different machine than
 * the one that wrote it. Feature-detection happens once at module load.
 */

import zlib from 'node:zlib';

/** Frame algorithm id bytes (format-normative — the byte IS the on-wire tag). */
export const ALGO_STORE = 0x00;
export const ALGO_ZSTD = 0x01;
export const ALGO_DEFLATE = 0x02;

/**
 * zstd level 3 (the library default) pinned explicitly so the writer's output
 * is stable for a given runtime: a retried upload re-frames byte-identically,
 * preserving G7 idempotent PUTs. Cross-zstd-version output may differ, but that
 * never breaks dedup or idempotency — the object KEY addresses the raw
 * plaintext (id + nonce both derive from it), so a differing machine's write
 * lands at the same key and is skipped via `head()`, and a same-machine retry
 * re-compresses identically. See FORMAT.md § Chunk payload framing.
 */
const ZSTD_LEVEL = 3;

// Feature-detect zstd once. `deflateRawSync`/`inflateRawSync` are always
// present (they predate zstd by a decade), so the fallback path never needs a
// guard — only the preferred zstd path does.
const zstdCompressSync: typeof zlib.zstdCompressSync | undefined =
  typeof zlib.zstdCompressSync === 'function' ? zlib.zstdCompressSync : undefined;
const zstdDecompressSync: typeof zlib.zstdDecompressSync | undefined =
  typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : undefined;

/** True when this runtime can emit AND read `0x01` zstd frames (Node ≥22.15 / Bun 1.3+). */
export const zstdAvailable = zstdCompressSync !== undefined && zstdDecompressSync !== undefined;

function compressBody(plain: Uint8Array): { algo: number; body: Buffer } {
  if (zstdCompressSync) {
    return {
      algo: ALGO_ZSTD,
      body: zstdCompressSync(plain, {
        params: { [zlib.constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL },
      }),
    };
  }
  // Runtime without zstd: raw-deflate under its own id byte. The reader on the
  // eventual restore machine handles `0x02` whether or not IT has zstd.
  return { algo: ALGO_DEFLATE, body: zlib.deflateRawSync(plain) };
}

/**
 * Frame raw part bytes into the sealed-payload plaintext `[algo-id][body]`.
 *
 * Keep-if-smaller gate (#405 §1): both candidate frames carry the same 1-byte
 * header, so the comparison reduces to `compressedBody.length < raw.length` —
 * strictly smaller wins, ties and inflation store raw. That bounds the worst
 * case (incompressible input) at exactly one extra byte, never inflation.
 */
export function frameChunkPayload(plain: Uint8Array): Uint8Array {
  const { algo, body } = compressBody(plain);
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

/**
 * Reverse `frameChunkPayload`: recover the raw plaintext from a decrypted
 * sealed payload. Handles every id byte a conformant writer could have emitted,
 * regardless of what the LOCAL runtime can compress — a backup is routinely
 * read on a machine other than the one that wrote it (#405 §1).
 */
export function unframeChunkPayload(framed: Uint8Array): Uint8Array {
  if (framed.length < 1) throw new Error('unframeChunkPayload: empty frame (missing algo id byte)');
  const algo = framed[0]!; // length checked above; `!` satisfies noUncheckedIndexedAccess
  const body = framed.subarray(1);
  switch (algo) {
    case ALGO_STORE:
      return body;
    case ALGO_ZSTD:
      if (!zstdDecompressSync) {
        throw new Error(
          'unframeChunkPayload: object is zstd-framed (0x01) but this runtime has no ' +
            'node:zlib zstd — restore on Node ≥22.15 or Bun ≥1.3',
        );
      }
      return new Uint8Array(zstdDecompressSync(body));
    case ALGO_DEFLATE:
      return new Uint8Array(zlib.inflateRawSync(body));
    default:
      throw new Error(`unframeChunkPayload: unknown frame algorithm id 0x${algo.toString(16)}`);
  }
}
