/*
 * Identity is fail-closed (issue #750 invariant 1): a vault's peers pinned
 * its public key at link time, so a missing or swapped seed for a vault that
 * already minted one must REFUSE loudly — never silently mint a replacement
 * key that would make every signed route assertion fail downstream.
 */

import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  loadOrCreateVaultIdentitySeed,
  VaultIdentityMismatchError,
} from "./vault-identity.js";

function seedFile(): string {
  return path.join(tempDirSync("vault-identity-"), "keys", "vlt_x.identity");
}

describe("loadOrCreateVaultIdentitySeed (#750 fail-closed identity)", () => {
  test("a fresh vault mints the seed AND its public-key pin together", () => {
    const file = seedFile();
    const seed = loadOrCreateVaultIdentitySeed(file);
    expect(seed).toHaveLength(32);
    expect(readdirSync(path.dirname(file)).sort()).toStrictEqual([
      "vlt_x.identity",
      "vlt_x.identity.pub",
    ]);
    // Reopening loads the SAME seed — the pin agrees with what it derives.
    expect(loadOrCreateVaultIdentitySeed(file).equals(seed)).toBe(true);
  });

  test("pin present but seed missing refuses loudly, mints nothing, keeps the pin", () => {
    const file = seedFile();
    loadOrCreateVaultIdentitySeed(file);
    const pinFile = `${file}.pub`;
    const pinBytes = readFileSync(pinFile);
    unlinkSync(file);
    let refusal: unknown;
    try {
      loadOrCreateVaultIdentitySeed(file);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(VaultIdentityMismatchError);
    expect((refusal as VaultIdentityMismatchError).code).toBe(
      "vault_identity_mismatch"
    );
    // Nothing minted, pin untouched: the refusal changes no custody state.
    expect(readdirSync(path.dirname(file)).sort()).toStrictEqual([
      "vlt_x.identity.pub",
    ]);
    expect(readFileSync(pinFile).equals(pinBytes)).toBe(true);
  });

  test("a seed that does not match the pin refuses instead of loading a stranger's key", () => {
    const file = seedFile();
    const original = loadOrCreateVaultIdentitySeed(file);
    const pinFile = `${file}.pub`;
    const pinBytes = readFileSync(pinFile);
    // Overwrite the seed with a DIFFERENT vault's envelope — the
    // swapped-disk / restored-wrong-backup shape.
    const otherFile = seedFile();
    const other = loadOrCreateVaultIdentitySeed(otherFile);
    expect(other.equals(original)).toBe(false);
    writeFileSync(file, readFileSync(otherFile));
    expect(() => loadOrCreateVaultIdentitySeed(file)).toThrow(
      VaultIdentityMismatchError
    );
    expect(() => loadOrCreateVaultIdentitySeed(file)).toThrow(
      /pinned public key/u
    );
    // The pin still names the ORIGINAL identity — a refusal writes nothing.
    expect(readFileSync(pinFile).equals(pinBytes)).toBe(true);
  });

  test("a pre-pin vault (seed only) loads and gains its pin — the seed is the authority", () => {
    const file = seedFile();
    const seed = loadOrCreateVaultIdentitySeed(file);
    unlinkSync(`${file}.pub`);
    // Same shape as a crash between a fresh mint's two writes.
    const reloaded = loadOrCreateVaultIdentitySeed(file);
    expect(reloaded.equals(seed)).toBe(true);
    expect(readdirSync(path.dirname(file)).sort()).toStrictEqual([
      "vlt_x.identity",
      "vlt_x.identity.pub",
    ]);
    // The regained pin derives from the seed, so a third open still agrees —
    // this branch can never launder a wrong key, only re-derive the same one.
    expect(loadOrCreateVaultIdentitySeed(file).equals(seed)).toBe(true);
  });
});
