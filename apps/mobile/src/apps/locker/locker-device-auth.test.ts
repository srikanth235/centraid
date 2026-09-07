import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  LOCKER_SESSION_TIMEOUT_MS,
  lockerDeviceCredentialId,
  lockerUnlocked,
  lockLocker,
  newLockerDeviceSecret,
  readLockerDeviceCredential,
  readLockerVaultKey,
  removeLockerDeviceCredential,
  removeLockerVaultKey,
  storeLockerDeviceCredential,
  storeLockerVaultKey,
} from "./locker-device-auth";

const state = vi.hoisted(() => ({
  async: new Map<string, string>(),
  secure: new Map<string, string>(),
  /** Every keychain read is an OS prompt — `requireAuthentication` is on. */
  prompts: 0,
}));

vi.mock(
  import("@react-native-async-storage/async-storage") as Promise<unknown>,
  () => ({
    default: {
      getItem: vi.fn<(key: string) => Promise<string | null>>(
        async (key) => state.async.get(key) ?? null
      ),
      removeItem: vi.fn<(key: string) => Promise<void>>(async (key) => {
        state.async.delete(key);
      }),
      setItem: vi.fn<(key: string, value: string) => Promise<void>>(
        async (key, value) => {
          state.async.set(key, value);
        }
      ),
    },
  })
);

vi.mock(import("expo-crypto") as Promise<unknown>, () => ({
  getRandomBytesAsync: vi.fn<() => Promise<Uint8Array>>(async () =>
    new Uint8Array(32).fill(171)
  ),
}));

const secureCacheCleared = vi.hoisted(() => ({ count: 0 }));
vi.mock(import("../../lib/secure-storage") as Promise<unknown>, () => ({
  clearSecureCache: () => {
    secureCacheCleared.count += 1;
  },
}));

vi.mock(import("expo-secure-store") as Promise<unknown>, () => ({
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 6,
  canUseBiometricAuthentication: () => true,
  deleteItemAsync: vi.fn<(key: string) => Promise<void>>(async (key) => {
    state.secure.delete(key);
  }),
  getItemAsync: vi.fn<(key: string) => Promise<string | null>>(async (key) => {
    state.prompts += 1;
    return state.secure.get(key) ?? null;
  }),
  setItemAsync: vi.fn<(key: string, value: string) => Promise<void>>(
    async (key, value) => {
      state.secure.set(key, value);
    }
  ),
}));

describe("Locker biometric device credential", () => {
  beforeEach(() => {
    state.async.clear();
    state.secure.clear();
    state.prompts = 0;
    lockLocker();
    secureCacheCleared.count = 0;
  });

  test("generates a full 32-byte device secret", async () => {
    await expect(newLockerDeviceSecret()).resolves.toBe("ab".repeat(32));
  });

  test("stores the id only after the authenticated secret verifies", async () => {
    await storeLockerDeviceCredential("device-1", "secret");
    await expect(lockerDeviceCredentialId()).resolves.toBe("device-1");
    await expect(readLockerDeviceCredential()).resolves.toStrictEqual({
      credentialId: "device-1",
      secret: "secret",
    });
  });

  test("removes both halves of the local device credential", async () => {
    await storeLockerDeviceCredential("device-1", "secret");
    await removeLockerDeviceCredential();
    await expect(lockerDeviceCredentialId()).resolves.toBeNull();
    await expect(readLockerDeviceCredential()).resolves.toBeNull();
  });
});

describe("Locker vault key behind the OS prompt (#996, R13)", () => {
  beforeEach(() => {
    state.secure.clear();
    state.prompts = 0;
    lockLocker();
    secureCacheCleared.count = 0;
  });

  const RECORD = { keyId: "k-1", key: Buffer.alloc(32, 3).toString("base64") };

  test("stores `K` only after the authenticated read-back verifies", async () => {
    await storeLockerVaultKey("v-1", RECORD);
    lockLocker();
    await expect(readLockerVaultKey("v-1")).resolves.toStrictEqual(RECORD);
  });

  test("the first reveal prompts; the rest of the session does not", async () => {
    await storeLockerVaultKey("v-1", RECORD);
    lockLocker();
    state.prompts = 0;

    await readLockerVaultKey("v-1", 0);
    expect(state.prompts).toBe(1);
    expect(lockerUnlocked(0)).toBe(true);

    // Three more reveals inside the window: the keychain is not touched, and
    // a prompt per field is a prompt nobody reads.
    await readLockerVaultKey("v-1", 1_000);
    await readLockerVaultKey("v-1", 2_000);
    await readLockerVaultKey("v-1", 3_000);
    expect(state.prompts).toBe(1);
  });

  test("after the timeout the OS prompts again", async () => {
    await storeLockerVaultKey("v-1", RECORD);
    lockLocker();
    state.prompts = 0;

    await readLockerVaultKey("v-1", 0);
    // No timer ran — a backgrounded React Native app runs none — and the
    // session is over anyway, because the clock is checked, not scheduled.
    expect(lockerUnlocked(LOCKER_SESSION_TIMEOUT_MS)).toBe(false);
    await readLockerVaultKey("v-1", LOCKER_SESSION_TIMEOUT_MS);
    expect(state.prompts).toBe(2);
  });

  test("lock drops the session and every other decrypted credential with it", async () => {
    await storeLockerVaultKey("v-1", RECORD);
    await readLockerVaultKey("v-1", 0);
    expect(lockerUnlocked(0)).toBe(true);

    lockLocker();

    expect(lockerUnlocked(0)).toBe(false);
    // One gesture, not three: `clearSecureCache()` is the app's whole
    // in-memory credential store.
    expect(secureCacheCleared.count).toBe(1);
  });

  test("another vault's key never satisfies this vault's session", async () => {
    await storeLockerVaultKey("v-1", RECORD);
    await readLockerVaultKey("v-1", 0);
    state.prompts = 0;
    await expect(readLockerVaultKey("v-2", 0)).resolves.toBeNull();
    expect(state.prompts).toBe(1);
    expect(lockerUnlocked(0)).toBe(false);
  });

  test("revoke forgets `K` on this device", async () => {
    await storeLockerVaultKey("v-1", RECORD);
    await readLockerVaultKey("v-1", 0);
    await removeLockerVaultKey("v-1");
    expect(lockerUnlocked(0)).toBe(false);
    await expect(readLockerVaultKey("v-1", 0)).resolves.toBeNull();
  });
});
