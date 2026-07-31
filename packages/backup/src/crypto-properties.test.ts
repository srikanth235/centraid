import { describe, expect, test } from "vitest";

import { fc } from "@centraid/test-kit/fast-check";

import {
  chunkId,
  decrypt,
  deriveDataKey,
  deriveDedupKey,
  deriveNonce,
  encrypt,
  encryptWithNonce,
} from "./crypto.js";

const keyBytes: fc.Arbitrary<Uint8Array> = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((a) => new Uint8Array(a));

const plainBytes: fc.Arbitrary<Uint8Array> = fc
  .uint8Array({ minLength: 0, maxLength: 256 })
  .map((a) => new Uint8Array(a));

/**
 * Backup crypto properties (#532 core expansion).
 *
 * Model: AES-256-GCM round-trips; any bit flip or wrong key fails closed;
 * deterministic nonces and HKDF keys are pure functions of their inputs.
 */
describe("backup crypto property", () => {
  test("encrypt/decrypt round-trips every plaintext under every key", () => {
    fc.assert(
      fc.property(keyBytes, plainBytes, (key, plain) => {
        const blob = encrypt(key, plain);
        const back = decrypt(key, blob);
        expect([...back]).toStrictEqual([...plain]);
      }),
      { numRuns: 40, seed: 53240 }
    );
  });

  test("encryptWithNonce is deterministic for the same (key, nonce, plain, aad)", () => {
    fc.assert(
      fc.property(
        keyBytes,
        fc.uint8Array({ minLength: 12, maxLength: 12 }),
        plainBytes,
        fc.option(fc.uint8Array({ minLength: 0, maxLength: 32 }), {
          nil: undefined,
        }),
        (key, nonceArr, plain, aadOpt) => {
          const nonce = new Uint8Array(nonceArr);
          const aad = aadOpt === undefined ? undefined : new Uint8Array(aadOpt);
          const a = encryptWithNonce(key, nonce, plain, aad);
          const b = encryptWithNonce(key, nonce, plain, aad);
          expect([...a]).toStrictEqual([...b]);
          expect([...decrypt(key, a, aad)]).toStrictEqual([...plain]);
        }
      ),
      { numRuns: 32, seed: 53241 }
    );
  });

  test("any single-byte ciphertext flip fails auth", () => {
    fc.assert(
      fc.property(
        keyBytes,
        plainBytes,
        fc.integer({ min: 0, max: 10_000 }),
        (key, plain, salt) => {
          const blob = encrypt(key, plain);
          fc.pre(blob.length > 0);
          const idx = salt % blob.length;
          const tampered = new Uint8Array(blob);
          tampered[idx] = (tampered[idx]! ^ 0xff) & 0xff;
          // If flip produced identical byte (impossible with XOR 0xff on byte), skip.
          if (tampered[idx] === blob[idx]) return;
          expect(() => decrypt(key, tampered)).toThrow(
            /unsupported state or unable to authenticate data/iu
          );
        }
      ),
      { numRuns: 32, seed: 53242 }
    );
  });

  test("wrong key never decrypts", () => {
    fc.assert(
      fc.property(keyBytes, keyBytes, plainBytes, (key, wrong, plain) => {
        fc.pre([...key].some((b, i) => b !== wrong[i]));
        const blob = encrypt(key, plain);
        expect(() => decrypt(wrong, blob)).toThrow(
          /unsupported state or unable to authenticate data/iu
        );
      }),
      { numRuns: 24, seed: 53243 }
    );
  });

  test("deriveNonce is deterministic and 12 bytes", () => {
    fc.assert(
      fc.property(
        keyBytes,
        fc.string({ minLength: 1, maxLength: 64 }),
        (key, info) => {
          const a = deriveNonce(key, info);
          const b = deriveNonce(key, info);
          expect(a).toHaveLength(12);
          expect([...a]).toStrictEqual([...b]);
        }
      ),
      { numRuns: 32, seed: 53244 }
    );
  });

  test("distinct info strings yield distinct nonces (collision-resistant for samples)", () => {
    fc.assert(
      fc.property(
        keyBytes,
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        (key, infoA, infoB) => {
          fc.pre(infoA !== infoB);
          expect([...deriveNonce(key, infoA)]).not.toStrictEqual([
            ...deriveNonce(key, infoB),
          ]);
        }
      ),
      { numRuns: 24, seed: 53245 }
    );
  });

  test("data and dedup keys diverge for the same vaultId", () => {
    fc.assert(
      fc.property(
        keyBytes,
        fc.string({ minLength: 1, maxLength: 36 }),
        (master, vaultId) => {
          const data = deriveDataKey(master, vaultId);
          const dedup = deriveDedupKey(master, vaultId);
          expect(data).toHaveLength(32);
          expect(dedup).toHaveLength(32);
          expect([...data]).not.toStrictEqual([...dedup]);
        }
      ),
      { numRuns: 24, seed: 53246 }
    );
  });

  test("truncated blobs always fail closed", () => {
    fc.assert(
      fc.property(
        keyBytes,
        fc.uint8Array({ minLength: 0, maxLength: 27 }),
        (key, truncatedArr) => {
          const truncated = new Uint8Array(truncatedArr);
          expect(() => decrypt(key, truncated)).toThrow(
            "encrypted blob truncated"
          );
        }
      ),
      { numRuns: 24, seed: 53247 }
    );
  });
});

// ---------------------------------------------------------------------------
// Mutation-kill campaign (#656 Layer 1C).
//
// Laws the seal/derive surface owes FORMAT.md, stated over the whole input
// domain rather than over one hand-picked vector.
// ---------------------------------------------------------------------------

describe("backup crypto domain law", () => {
  test("a nonce that is not the format's 12 bytes is refused, not silently used", () => {
    // `decrypt` recovers the IV by slicing the FIRST 12 bytes back off the
    // blob. GCM itself accepts other IV lengths, so an encoder that passed one
    // through would emit a blob whose own reader mis-frames it — the
    // ciphertext would be unrecoverable rather than merely unreadable. The
    // length check is the only thing keeping the wire shape self-describing.
    fc.assert(
      fc.property(
        keyBytes,
        plainBytes,
        fc.integer({ min: 0, max: 40 }).filter((n) => n !== 12),
        (key, plain, len) => {
          const nonce = new Uint8Array(len);
          expect(() => encryptWithNonce(key, nonce, plain)).toThrow(/nonce/iu);
        }
      ),
      { numRuns: 40, seed: 53248 }
    );
  });

  test("a 12-byte nonce is accepted and is recoverable from the blob", () => {
    fc.assert(
      fc.property(
        keyBytes,
        fc.uint8Array({ minLength: 12, maxLength: 12 }),
        plainBytes,
        (key, nonceArr, plain) => {
          const nonce = new Uint8Array(nonceArr);
          const blob = encryptWithNonce(key, nonce, plain);
          // The wire shape IS `nonce || ct || tag` — the reader depends on it.
          expect([...blob.subarray(0, 12)]).toStrictEqual([...nonce]);
          expect([...decrypt(key, blob)]).toStrictEqual([...plain]);
        }
      ),
      { numRuns: 32, seed: 53249 }
    );
  });

  test("every vault gets its own data key and its own dedup key", () => {
    // Per-vault separation is the whole point of the HKDF info string: two
    // vaults under one master must not share a key, or a dedup index built for
    // one would confirm the other's contents.
    fc.assert(
      fc.property(
        keyBytes,
        fc.string({ minLength: 1, maxLength: 36 }),
        fc.string({ minLength: 1, maxLength: 36 }),
        (master, vaultA, vaultB) => {
          fc.pre(vaultA !== vaultB);
          expect([...deriveDataKey(master, vaultA)]).not.toStrictEqual([
            ...deriveDataKey(master, vaultB),
          ]);
          expect([...deriveDedupKey(master, vaultA)]).not.toStrictEqual([
            ...deriveDedupKey(master, vaultB),
          ]);
          // …and the two key DOMAINS never cross, for any pair of vaults.
          expect([...deriveDataKey(master, vaultA)]).not.toStrictEqual([
            ...deriveDedupKey(master, vaultB),
          ]);
        }
      ),
      { numRuns: 32, seed: 53250 }
    );
  });

  test("derived keys are a pure function of (master, vaultId)", () => {
    fc.assert(
      fc.property(
        keyBytes,
        keyBytes,
        fc.string({ minLength: 1, maxLength: 36 }),
        (master, otherMaster, vaultId) => {
          expect([...deriveDataKey(master, vaultId)]).toStrictEqual([
            ...deriveDataKey(master, vaultId),
          ]);
          fc.pre([...master].some((b, i) => b !== otherMaster[i]));
          expect([...deriveDataKey(master, vaultId)]).not.toStrictEqual([
            ...deriveDataKey(otherMaster, vaultId),
          ]);
        }
      ),
      { numRuns: 24, seed: 53251 }
    );
  });

  test("chunkId is a hex content address of the plaintext", () => {
    fc.assert(
      fc.property(keyBytes, plainBytes, (dedupKey, plain) => {
        const id = chunkId(dedupKey, plain);
        // Chunk ids are used as object-store key components, so the value has
        // to be a printable hex string — not a Buffer, not raw bytes.
        expect(id).toBeTypeOf("string");
        expect(id).toMatch(/^[0-9a-f]{64}$/u);
        expect(chunkId(dedupKey, plain)).toBe(id);
      }),
      { numRuns: 32, seed: 53252 }
    );
  });

  test("chunkId separates distinct plaintexts", () => {
    fc.assert(
      fc.property(keyBytes, plainBytes, plainBytes, (dedupKey, a, b) => {
        fc.pre(Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0);
        expect(chunkId(dedupKey, a)).not.toBe(chunkId(dedupKey, b));
      }),
      { numRuns: 32, seed: 53253 }
    );
  });

  test("chunkId is KEYED — the same bytes address differently per vault", () => {
    // Dedup must not span vaults or epochs, and a provider holding the ids
    // must not be able to confirm a guessed plaintext without the dedup key.
    // Both properties follow from the id depending on the key.
    fc.assert(
      fc.property(keyBytes, keyBytes, plainBytes, (keyA, keyB, plain) => {
        fc.pre([...keyA].some((b, i) => b !== keyB[i]));
        expect(chunkId(keyA, plain)).not.toBe(chunkId(keyB, plain));
      }),
      { numRuns: 24, seed: 53254 }
    );
  });
});
