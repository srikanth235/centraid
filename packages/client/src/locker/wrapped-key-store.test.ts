// WHERE THE WRAPPED KEY SITS (#996, R13). The desktop store is a BRIDGE, so
// what is testable here is the contract the preload has to honour — and the
// one thing that must NOT be in it.
import { describe, expect, test } from "vitest";

import { wrapVaultKey } from "./locker-unlock.js";
import {
  desktopWrappedKeyStore,
  memoryWrappedKeyStore,
} from "./wrapped-key-store.js";
import type { DesktopKeyBridge } from "./wrapped-key-store.js";

const PASSPHRASE = "correct horse battery staple";

function bridge(): DesktopKeyBridge & { blobs: Map<string, string> } {
  const blobs = new Map<string, string>();
  return {
    blobs,
    readLockerKey: async (vaultId) => blobs.get(vaultId) ?? null,
    writeLockerKey: async (vaultId, blob) => {
      blobs.set(vaultId, blob);
    },
    clearLockerKey: async (vaultId) => {
      blobs.delete(vaultId);
    },
  };
}

describe("wrapped-key-store", () => {
  test("the desktop bridge round-trips the wrapped blob and nothing else", async () => {
    const wire = bridge();
    const store = desktopWrappedKeyStore(wire);
    const wrapped = await wrapVaultKey(PASSPHRASE, {
      vaultId: "v-1",
      keyId: "k-1",
      key: new Uint8Array(32).fill(4),
    });
    await store.write(wrapped);
    await expect(store.read("v-1")).resolves.toStrictEqual(wrapped);

    // What crossed the bridge is ciphertext. `safeStorage` is at-rest custody
    // that prompts for nothing, so the only safe thing to put behind it is a
    // blob that is already useless without the passphrase.
    const crossed = wire.blobs.get("v-1") as string;
    expect(crossed).not.toContain(PASSPHRASE);
    expect(crossed).not.toContain(
      Buffer.from(new Uint8Array(32).fill(4)).toString("base64")
    );

    await store.clear("v-1");
    await expect(store.read("v-1")).resolves.toBeNull();
  });

  test("the bridge has no way to ask the main process for `K`", () => {
    // A `getLockerVaultKey()` on this interface would be the prompt-free path
    // R13 exists to close: the renderer unwraps, and main never holds the key.
    const wire = bridge();
    expect(
      Object.keys(wire)
        .filter((k) => k !== "blobs")
        .toSorted()
    ).toStrictEqual(["clearLockerKey", "readLockerKey", "writeLockerKey"]);
  });

  test("stores are per vault, and one vault's blob never answers another's", async () => {
    const store = memoryWrappedKeyStore();
    await store.write(
      await wrapVaultKey(PASSPHRASE, {
        vaultId: "v-1",
        keyId: "k-1",
        key: new Uint8Array(32).fill(1),
      })
    );
    await expect(store.read("v-2")).resolves.toBeNull();
  });
});
