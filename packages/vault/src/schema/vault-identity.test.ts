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
    expect(readFileSync(pinFile).equals(pinBytes)).toBe(true);
  });

  test("a pre-pin vault (seed only) loads and gains its pin — the seed is the authority", () => {
    const file = seedFile();
    const seed = loadOrCreateVaultIdentitySeed(file);
    unlinkSync(`${file}.pub`);
    const reloaded = loadOrCreateVaultIdentitySeed(file);
    expect(reloaded.equals(seed)).toBe(true);
    expect(readdirSync(path.dirname(file)).sort()).toStrictEqual([
      "vlt_x.identity",
      "vlt_x.identity.pub",
    ]);
    expect(loadOrCreateVaultIdentitySeed(file).equals(seed)).toBe(true);
  });
});
