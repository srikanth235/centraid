/*
 * ENROL, THEN REVEAL (#1015, ruling R-NY-19; #996 R13).
 *
 * The two halves meet here: the key door's answer goes into this device's
 * keychain through the enrol gesture, and a value the VAULT encrypted under
 * that same `K` opens on this device, offline, through `revealLockerRow`.
 * Encrypting on the gateway's implementation and decrypting on the seat's is
 * deliberate — they are two implementations of one envelope, and a test that
 * used one for both would not notice them drifting apart.
 *
 * It also pins the custody the key lands in: `requireAuthentication` and
 * `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`, exactly, and nothing in AsyncStorage.
 * Those two options are the whole boundary; a future edit that drops either
 * turns the keychain from a prompt into storage.
 */

import { randomBytes } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { encryptUnderLockerKey } from "@centraid/vault";

import { enrolThisPhoneInLocker } from "./locker-enrol";

const VAULT = "vault-1";
const KEY_ID = "key-1";
const ROW = "locker-item-1";
const SECRET = "correct horse battery staple";

const state = vi.hoisted(() => ({
  secure: new Map<string, string>(),
  secureWrites: [] as Array<{ key: string; options: unknown }>,
  asyncWrites: [] as string[],
}));

vi.mock(
  import("@react-native-async-storage/async-storage") as Promise<unknown>,
  () => ({
    default: {
      getItem: vi.fn<() => Promise<string | null>>(async () => null),
      removeItem: vi.fn<() => Promise<void>>(async () => undefined),
      setItem: vi.fn<(key: string) => Promise<void>>(async (key) => {
        state.asyncWrites.push(key);
      }),
    },
  })
);
vi.mock(import("expo-crypto") as Promise<unknown>, () => ({
  getRandomBytesAsync: vi.fn<() => Promise<Uint8Array>>(
    async () => new Uint8Array(32)
  ),
}));
vi.mock(import("../../lib/secure-storage") as Promise<unknown>, () => ({
  clearSecureCache: () => undefined,
}));
vi.mock(import("expo-secure-store") as Promise<unknown>, () => ({
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: "whenPasscodeSetThisDeviceOnly",
  canUseBiometricAuthentication: () => true,
  deleteItemAsync: vi.fn<(key: string) => Promise<void>>(async (key) => {
    state.secure.delete(key);
  }),
  getItemAsync: vi.fn<(key: string) => Promise<string | null>>(
    async (key) => state.secure.get(key) ?? null
  ),
  setItemAsync: vi.fn<
    (key: string, value: string, options: unknown) => Promise<void>
  >(async (key, value, options) => {
    state.secureWrites.push({ key, options });
    state.secure.set(key, value);
  }),
}));

describe("a phone that enrols can open what the vault sealed", () => {
  beforeEach(() => {
    state.secure.clear();
    state.secureWrites.length = 0;
    state.asyncWrites.length = 0;
  });

  it("stores K behind the OS prompt and reveals a vault-encrypted value", async () => {
    const key = randomBytes(32);
    const sealed = encryptUnderLockerKey(key, KEY_ID, ROW, SECRET);

    const enrolled = await enrolThisPhoneInLocker(VAULT, {
      tunnel: () => Promise.resolve({ baseUrl: "http://127.0.0.1:5555" }),
      headers: () => Promise.resolve({}),
      doFetch: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ capabilities: { seatLockerKey: true } })
          )
        )) as unknown as typeof globalThis.fetch,
      fetchKey: () =>
        Promise.resolve({
          vaultId: VAULT,
          keyId: KEY_ID,
          key: Uint8Array.from(key),
        }),
    });
    expect(enrolled).toStrictEqual({ ok: true, keyId: KEY_ID });

    // THE CUSTODY, EXACTLY. Both options are the boundary R13 names: without
    // `requireAuthentication` the keychain hands the key back with no person
    // present, and without the accessibility class the item exists on a
    // passcode-less device and travels in a backup.
    expect(state.secureWrites[0]?.options).toStrictEqual({
      authenticationPrompt: "Authenticate for Locker",
      keychainAccessible: "whenPasscodeSetThisDeviceOnly",
      requireAuthentication: true,
    });
    // Nothing durable but the keychain item.
    expect(state.asyncWrites).toStrictEqual([]);

    const { revealLockerRow } = await import("./locker-door");
    const recordReveal = vi.fn<() => Promise<{ receiptId: string }>>(
      async () => ({ receiptId: "receipt-1" })
    );
    const answer = await revealLockerRow({
      vaultId: VAULT,
      rowId: ROW,
      ciphertext: { password: sealed },
      keyId: KEY_ID,
      recordReveal,
    });
    expect(answer).toStrictEqual({
      ok: true,
      rowId: ROW,
      values: { password: SECRET },
      receiptId: "receipt-1",
    });
    // The receipt is the ONLY record that anyone looked, so it is awaited
    // before the plaintext reaches a screen (W6-D2).
    expect(recordReveal).toHaveBeenCalledOnce();
  });
});
