import { describe, expect, test } from 'vitest';
import { fc } from '@centraid/test-kit/fast-check';
import {
  decrypt,
  deriveDataKey,
  deriveDedupKey,
  deriveNonce,
  encrypt,
  encryptWithNonce,
} from './crypto.js';

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
describe('backup crypto property', () => {
  test('encrypt/decrypt round-trips every plaintext under every key', () => {
    fc.assert(
      fc.property(keyBytes, plainBytes, (key, plain) => {
        const blob = encrypt(key, plain);
        const back = decrypt(key, blob);
        expect([...back]).toEqual([...plain]);
      }),
      { numRuns: 40, seed: 53240 },
    );
  });

  test('encryptWithNonce is deterministic for the same (key, nonce, plain, aad)', () => {
    fc.assert(
      fc.property(
        keyBytes,
        fc.uint8Array({ minLength: 12, maxLength: 12 }),
        plainBytes,
        fc.option(fc.uint8Array({ minLength: 0, maxLength: 32 }), { nil: undefined }),
        (key, nonceArr, plain, aadOpt) => {
          const nonce = new Uint8Array(nonceArr);
          const aad = aadOpt === undefined ? undefined : new Uint8Array(aadOpt);
          const a = encryptWithNonce(key, nonce, plain, aad);
          const b = encryptWithNonce(key, nonce, plain, aad);
          expect([...a]).toEqual([...b]);
          expect([...decrypt(key, a, aad)]).toEqual([...plain]);
        },
      ),
      { numRuns: 32, seed: 53241 },
    );
  });

  test('any single-byte ciphertext flip fails auth', () => {
    fc.assert(
      fc.property(keyBytes, plainBytes, fc.integer({ min: 0, max: 10_000 }), (key, plain, salt) => {
        const blob = encrypt(key, plain);
        fc.pre(blob.length > 0);
        const idx = salt % blob.length;
        const tampered = new Uint8Array(blob);
        tampered[idx] = (tampered[idx]! ^ 0xff) & 0xff;
        // If flip produced identical byte (impossible with XOR 0xff on byte), skip.
        if (tampered[idx] === blob[idx]) return;
        expect(() => decrypt(key, tampered)).toThrow();
      }),
      { numRuns: 32, seed: 53242 },
    );
  });

  test('wrong key never decrypts', () => {
    fc.assert(
      fc.property(keyBytes, keyBytes, plainBytes, (key, wrong, plain) => {
        fc.pre([...key].some((b, i) => b !== wrong[i]));
        const blob = encrypt(key, plain);
        expect(() => decrypt(wrong, blob)).toThrow();
      }),
      { numRuns: 24, seed: 53243 },
    );
  });

  test('deriveNonce is deterministic and 12 bytes', () => {
    fc.assert(
      fc.property(keyBytes, fc.string({ minLength: 1, maxLength: 64 }), (key, info) => {
        const a = deriveNonce(key, info);
        const b = deriveNonce(key, info);
        expect(a.length).toBe(12);
        expect([...a]).toEqual([...b]);
      }),
      { numRuns: 32, seed: 53244 },
    );
  });

  test('distinct info strings yield distinct nonces (collision-resistant for samples)', () => {
    fc.assert(
      fc.property(
        keyBytes,
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        (key, infoA, infoB) => {
          fc.pre(infoA !== infoB);
          expect([...deriveNonce(key, infoA)]).not.toEqual([...deriveNonce(key, infoB)]);
        },
      ),
      { numRuns: 24, seed: 53245 },
    );
  });

  test('data and dedup keys diverge for the same vaultId', () => {
    fc.assert(
      fc.property(keyBytes, fc.string({ minLength: 1, maxLength: 36 }), (master, vaultId) => {
        const data = deriveDataKey(master, vaultId);
        const dedup = deriveDedupKey(master, vaultId);
        expect(data.length).toBe(32);
        expect(dedup.length).toBe(32);
        expect([...data]).not.toEqual([...dedup]);
      }),
      { numRuns: 24, seed: 53246 },
    );
  });

  test('truncated blobs always fail closed', () => {
    fc.assert(
      fc.property(keyBytes, fc.uint8Array({ minLength: 0, maxLength: 27 }), (key, truncatedArr) => {
        const truncated = new Uint8Array(truncatedArr);
        expect(() => decrypt(key, truncated)).toThrow();
      }),
      { numRuns: 24, seed: 53247 },
    );
  });
});
