import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { expect } from "vitest";

import { KeyStore } from "@centraid/vault";

/**
 * A recovery that refuses must leave the machine exactly as blank as it found
 * it:
 * no vault directory, no `.recover-staging-*` scratch, and nothing escrowed
 * into the key store. One call, so the blank-machine test states it whole —
 * a half-materialized vault is worse than no vault, because the next
 * recovery would adopt it.
 */
export async function expectRefusalLeavesNoResidue(
  attempt: () => Promise<unknown>,
  refusal: RegExp,
  layout: { vaultDir: string; keysDir: string },
  vaultId: string
): Promise<void> {
  await expect(attempt()).rejects.toThrow(refusal);
  expect(existsSync(path.join(layout.vaultDir, vaultId))).toBe(false);
  const rootEntries = existsSync(layout.vaultDir)
    ? await fs.readdir(layout.vaultDir)
    : [];
  expect(
    rootEntries.filter((entry) => entry.startsWith(".recover-staging-"))
  ).toHaveLength(0);
  expect(new KeyStore(layout.keysDir).export("keyring.key")).toBeNull();
}
