import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  clearSecureCache,
  getSecure,
  hydrateSecure,
  setSecure,
} from "./secure-storage";

const state = vi.hoisted(() => ({
  values: new Map<string, string>(),
  getError: undefined as Error | undefined,
  setError: undefined as Error | undefined,
}));

vi.mock(import("expo-secure-store") as Promise<unknown>, () => ({
  deleteItemAsync: vi.fn<(key: string) => Promise<void>>(async (key) => {
    if (state.setError) throw state.setError;
    state.values.delete(key);
  }),
  getItemAsync: vi.fn<(key: string) => Promise<string | null>>(async (key) => {
    if (state.getError) throw state.getError;
    return state.values.get(key) ?? null;
  }),
  setItemAsync: vi.fn<(key: string, value: string) => Promise<void>>(
    async (key, value) => {
      if (state.setError) throw state.setError;
      state.values.set(key, value);
    }
  ),
}));

describe("secure storage", () => {
  beforeEach(() => {
    state.values.clear();
    state.getError = undefined;
    state.setError = undefined;
    clearSecureCache();
  });

  test("hydrates missing keys from the supplied fallback", async () => {
    await expect(hydrateSecure("missing", "fallback")).resolves.toBe(
      "fallback"
    );
    expect(getSecure("missing")).toBe("fallback");
  });

  test("propagates secure-store read failures instead of inventing a value", async () => {
    state.getError = new Error("keychain unavailable");
    await expect(hydrateSecure("secret", "fallback")).rejects.toThrow(
      "keychain unavailable"
    );
    expect(getSecure("secret", "fallback")).toBe("fallback");
  });

  test("updates the cache only after a successful write", async () => {
    state.setError = new Error("keychain locked");
    await expect(setSecure("secret", "value")).rejects.toThrow(
      "keychain locked"
    );
    expect(getSecure("secret", "fallback")).toBe("fallback");

    state.setError = undefined;
    await setSecure("secret", "value");
    expect(getSecure("secret")).toBe("value");
  });
});
