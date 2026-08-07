// The share-target pointer record (issue #712, A1) and its refusal sentence.
// Mirrors `kit/transfer/transfer-policy.test.ts`'s Store stand-in so the
// record logic runs under node without a native AsyncStorage module.
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SHARE_TARGET,
  SHARE_TARGET_KEY,
  hydrateShareTarget,
  shareDestinationReason,
  writeShareTarget,
} from "./share-target";

vi.mock(import("../../storage") as Promise<unknown>, () => {
  const cache = new Map<string, unknown>();
  return {
    Store: {
      get: <T>(key: string, fallback: T): T =>
        cache.has(key) ? (cache.get(key) as T) : fallback,
      hydrate: <T>(key: string, fallback: T): Promise<T> =>
        Promise.resolve(cache.has(key) ? (cache.get(key) as T) : fallback),
      set: <T>(key: string, value: T): void => {
        cache.set(key, value);
      },
    },
  };
});

describe("the share-target record", () => {
  it("defaults to nothing chosen", () => {
    expect(DEFAULT_SHARE_TARGET).toStrictEqual({ vaultId: null });
  });

  it("is namespaced under frame., not an app's own key", () => {
    expect(SHARE_TARGET_KEY).toBe("frame.shareTarget");
  });

  it("round-trips through durable storage", async () => {
    writeShareTarget({ vaultId: "vault-family" });
    await expect(hydrateShareTarget()).resolves.toStrictEqual({
      vaultId: "vault-family",
    });
  });
});

describe(shareDestinationReason, () => {
  it("says there is nowhere to share to when nothing has ever been chosen", () => {
    expect(shareDestinationReason([{ vaultId: "own" }], undefined)).toBe(
      "There is nowhere to share to on this device yet."
    );
  });

  it("says the chosen place isn't open here when the pointer names an unmounted vault", () => {
    expect(
      shareDestinationReason([{ vaultId: "own" }], "vault-elsewhere")
    ).toBe("Where your shares go isn't open on this device.");
  });

  it("resolves to null once the pointer names a mounted vault", () => {
    expect(
      shareDestinationReason(
        [{ vaultId: "own" }, { vaultId: "vault-family" }],
        "vault-family"
      )
    ).toBeNull();
  });
});
