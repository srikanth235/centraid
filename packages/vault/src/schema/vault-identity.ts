/*
 * The vault identity keypair (issue #726 P1 — "a vault per person").
 *
 * Every vault mints an Ed25519 seed at creation, named `<vaultId>.identity`
 * in the SAME KeyStore/envelope/custody as the sealing key
 * (`<vaultId>.sealkey`): same directory, same envelope scheme, same
 * recovery-kit path. It is the vault's own signing identity — independent of
 * any device or owner — so a vault that moves hosts can prove, to a peer
 * that recorded its public key beforehand, that the thing on the new host is
 * the SAME vault.
 *
 * Minted alongside the DEK on every open: a fresh vault creates one, an
 * existing vault loads its own. Identity is FAIL-CLOSED (issue #750
 * invariant 1): the mint also pins the derived public key in a
 * `<vaultId>.identity.pub` sidecar (same KeyStore, same keys dir, same
 * custody), and a later open with the pin present but the seed missing or
 * mismatched throws `VaultIdentityMismatchError` instead of silently minting
 * a replacement key. Peers recorded that public key at link time — a
 * replacement seed would not be "this vault with a hiccup", it would be a
 * different vault wearing its id, and every signed route assertion would
 * fail against what the peers pinned. A seed WITHOUT a pin still loads (a
 * vault minted before the pin existed, or a crash between the mint's two
 * writes) and is pinned on the spot — the seed itself is the authority the
 * pin is derived from, so this branch can never launder a wrong key.
 */

import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import path from "node:path";

import type { KeyStore } from "./key-store.js";
import { keyStoreForFile } from "./sealed.js";

const IDENTITY_SEED_BYTES = 32;

// Fixed DER headers for a raw Ed25519 key (RFC 8410): the algorithm has no
// parameters, so wrapping a 32-byte seed/public key is always this constant
// prefix followed by the raw bytes.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Deterministic key path, mirroring `sealKeyFileFor`: `<dataRoot>/keys/<id>.identity`. */
export function identityKeyFileFor(vaultDir: string): string {
  const resolved = path.resolve(vaultDir);
  const vaultRoot = path.dirname(resolved);
  const dataRoot =
    path.basename(vaultRoot) === "vault" ? path.dirname(vaultRoot) : vaultRoot;
  return path.join(dataRoot, "keys", `${path.basename(resolved)}.identity`);
}

/** Fresh random seed for in-memory vaults (tests) — never persisted. */
export function ephemeralVaultIdentitySeed(): Buffer {
  return randomBytes(IDENTITY_SEED_BYTES);
}

/**
 * The identity custody refusal (issue #750 invariant 1): the vault's pinned
 * public key exists but the seed that produced it is missing or different.
 * Thrown, never worked around — minting a fresh seed here would silently
 * re-key a vault whose peers pinned the old key at link time. `code` is the
 * stable contract for gateway/commons callers to name.
 */
export class VaultIdentityMismatchError extends Error {
  readonly code = "vault_identity_mismatch";
  constructor(
    readonly file: string,
    detail: string
  ) {
    super(`vault identity at ${file} ${detail}`);
    this.name = "VaultIdentityMismatchError";
  }
}

/**
 * Load the vault's identity seed, fail-closed against identity loss:
 *
 *   - seed + pin present and matching → load;
 *   - pin present, seed missing or mismatched → `VaultIdentityMismatchError`
 *     (never a silent re-mint — the pin is untouched, no key is written);
 *   - seed present, no pin (pre-pin vault, or a crash between a fresh mint's
 *     two writes) → load and pin the derived public key now;
 *   - neither (genuinely new vault) → mint seed AND pin. The seed is written
 *     first, so a crash between the two resolves to the branch above and
 *     re-derives the SAME pin — never a pin without its seed.
 */
export function loadOrCreateVaultIdentitySeed(
  file: string,
  keyStore?: KeyStore
): Buffer {
  const store = keyStoreForFile(file, keyStore);
  const seedName = path.basename(file);
  const pinName = `${seedName}.pub`;
  const seed = store.load(seedName);
  const pin = store.load(pinName);
  if (seed !== null) {
    const publicKey = vaultIdentityPublicKey(seed);
    if (pin !== null && !publicKey.equals(pin)) {
      throw new VaultIdentityMismatchError(
        file,
        "does not match its pinned public key — this seed is not the identity " +
          "this vault's peers know; restore the original seed (or erase and " +
          "re-link the vault) instead of opening with a stranger's key"
      );
    }
    if (pin === null) store.store(pinName, publicKey);
    return seed;
  }
  if (pin !== null) {
    throw new VaultIdentityMismatchError(
      file,
      "is pinned but the seed file is missing — refusing to mint a " +
        "replacement key for a vault whose peers pinned the original; " +
        "restore the seed from the recovery kit (or erase and re-link)"
    );
  }
  const minted = store.create(seedName);
  store.store(pinName, vaultIdentityPublicKey(minted));
  return minted;
}

function assertSeedLength(seed: Buffer): void {
  if (seed.length !== IDENTITY_SEED_BYTES) {
    throw new Error(
      `vault identity seed must be ${IDENTITY_SEED_BYTES} bytes, got ${seed.length}`
    );
  }
}

/** The Ed25519 private key object for a raw 32-byte seed (RFC 8410 PKCS8). */
function privateKeyFromSeed(seed: Buffer) {
  assertSeedLength(seed);
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

/** The 32-byte raw Ed25519 public key derived from an identity seed. */
export function vaultIdentityPublicKey(seed: Buffer): Buffer {
  const der = createPublicKey(privateKeyFromSeed(seed)).export({
    format: "der",
    type: "spki",
  });
  return Buffer.from(der.subarray(der.length - IDENTITY_SEED_BYTES));
}

/** Sign `bytes` with the vault's identity seed (Ed25519 — no digest, whole message). */
export function signWithVaultIdentity(seed: Buffer, bytes: Buffer): Buffer {
  return sign(null, bytes, privateKeyFromSeed(seed));
}

/** Verify a signature against a raw 32-byte Ed25519 public key. */
export function verifyVaultIdentitySignature(
  publicKey: Buffer,
  bytes: Buffer,
  signature: Buffer
): boolean {
  assertSeedLength(publicKey);
  const key = createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, publicKey]),
    format: "der",
    type: "spki",
  });
  return verify(null, bytes, key, signature);
}
