import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  appLockEnabled,
  authenticateAppLock,
  disableAppLock,
  enableAppLock,
} from "./app-lock";

const state = vi.hoisted(() => ({
  async: new Map<string, string>(),
  secure: new Map<string, string>(),
  supported: true,
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
  randomUUID: vi.fn<() => string>(() => "gate-token"),
}));

vi.mock(import("expo-secure-store") as Promise<unknown>, () => ({
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 6,
  canUseBiometricAuthentication: () => state.supported,
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

describe("mobile biometric app lock storage", () => {
  beforeEach(() => {
    state.async.clear();
    state.secure.clear();
    state.supported = true;
  });

  test("enables only after the authenticated key reads back", async () => {
    await enableAppLock();
    await expect(appLockEnabled()).resolves.toBe(true);
    await expect(authenticateAppLock()).resolves.toBe(true);
  });

  test("refuses enrollment when device biometrics are unavailable", async () => {
    state.supported = false;
    await expect(enableAppLock()).rejects.toThrow("Set up Face ID");
    await expect(appLockEnabled()).resolves.toBe(false);
  });

  test("disable removes both the protected key and preference", async () => {
    await enableAppLock();
    await disableAppLock();
    await expect(appLockEnabled()).resolves.toBe(false);
    await expect(authenticateAppLock()).resolves.toBe(false);
  });
});
