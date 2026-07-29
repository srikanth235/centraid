import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  lockerDeviceCredentialId,
  newLockerDeviceSecret,
  readLockerDeviceCredential,
  removeLockerDeviceCredential,
  storeLockerDeviceCredential,
} from "./locker-device-auth";

const state = vi.hoisted(() => ({
  async: new Map<string, string>(),
  secure: new Map<string, string>(),
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

vi.mock(import("expo-secure-store") as Promise<unknown>, () => ({
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 6,
  canUseBiometricAuthentication: () => true,
  deleteItemAsync: vi.fn<(key: string) => Promise<void>>(async (key) => {
    state.secure.delete(key);
  }),
  getItemAsync: vi.fn<(key: string) => Promise<string | null>>(
    async (key) => state.secure.get(key) ?? null
  ),
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
