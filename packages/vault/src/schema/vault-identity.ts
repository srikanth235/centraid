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
 * v0 scope: minted alongside the DEK on every open (a fresh vault creates
 * one; an existing vault loads its own, or mints lazily if it predates this
 * feature — no backfill migration, deliberately, since nothing reads it over
 * the wire yet). Unlike the sealed-column DEK, there is no "sealed anything
 * yet?" fingerprint gate: the seed is either present (load) or absent
 * (mint), never wrong-and-refused.
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

/** Load the vault's identity seed, minting it on first use — no fingerprint
 *  gate (unlike the DEK): a vault either has one or gets one, never a refusal. */
export function loadOrCreateVaultIdentitySeed(
  file: string,
  keyStore?: KeyStore
): Buffer {
  return keyStoreForFile(file, keyStore).loadOrCreate(path.basename(file));
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
