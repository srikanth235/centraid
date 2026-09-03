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

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function identityKeyFileFor(vaultDir: string): string {
  const resolved = path.resolve(vaultDir);
  const vaultRoot = path.dirname(resolved);
  const dataRoot =
    path.basename(vaultRoot) === "vault" ? path.dirname(vaultRoot) : vaultRoot;
  return path.join(dataRoot, "keys", `${path.basename(resolved)}.identity`);
}

export function ephemeralVaultIdentitySeed(): Buffer {
  return randomBytes(IDENTITY_SEED_BYTES);
}

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

function privateKeyFromSeed(seed: Buffer) {
  assertSeedLength(seed);
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

export function vaultIdentityPublicKey(seed: Buffer): Buffer {
  const der = createPublicKey(privateKeyFromSeed(seed)).export({
    format: "der",
    type: "spki",
  });
  return Buffer.from(der.subarray(der.length - IDENTITY_SEED_BYTES));
}

export function signWithVaultIdentity(seed: Buffer, bytes: Buffer): Buffer {
  return sign(null, bytes, privateKeyFromSeed(seed));
}

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
