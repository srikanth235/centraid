import { describe, expect, test, vi } from "vitest";

import type { AsyncStorageLike } from "./native-change-feed";
import { NativeMultiplexChangeFeed } from "./native-multiplex-change-feed";

vi.mock(import("expo/fetch"), () => ({
  fetch: vi.fn<(typeof import("expo/fetch"))["fetch"]>(),
}));

function memoryStorage(): AsyncStorageLike & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => Promise.resolve(values.get(key) ?? null),
    setItem: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
    removeItem: (key) => {
      values.delete(key);
      return Promise.resolve();
    },
  };
}

describe(NativeMultiplexChangeFeed, () => {
  test("one revoked frame purges only that cursor and leaves other scopes mounted", async () => {
    const storage = memoryStorage();
    let resolveRevoked = (_vaultId: string): void => undefined;
    const revoked = new Promise<string>((resolve) => {
      resolveRevoked = resolve;
    });
    const requested: string[] = [];
    const feed = new NativeMultiplexChangeFeed({
      gatewayAuth: { baseUrl: "http://gateway", gatewayId: "gateway-1" },
      storage,
      minReconnectMs: 60_000,
      maxReconnectMs: 60_000,
      streamFetch: async (input) => {
        requested.push(String(input));
        const mounts = new URL(String(input)).searchParams.get("mounts") ?? "";
        return new Response(
          mounts.includes("family")
            ? `event: scope\ndata: ${JSON.stringify({
                vaultId: "family",
                event: "revoked",
                data: { reason: "device-access-changed" },
              })}\n\n`
            : "",
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }
        ) as never;
      },
      onScopeRevoked: resolveRevoked,
    });
    const personal = feed.scope("personal");
    const family = feed.scope("family");
    personal.subscribe(() => undefined);
    family.subscribe(() => undefined);
    personal.setActive(true);
    family.setActive(true);

    await expect(revoked).resolves.toBe("family");
    await new Promise((resolve) => setTimeout(resolve, 0));
    feed.close();
    expect(
      [...storage.values.keys()].some((key) => key.includes("family"))
    ).toBe(false);
    const lastMounts = new URL(requested.at(-1)!).searchParams.get("mounts");
    expect(lastMounts).toContain("personal");
    expect(lastMounts).not.toContain("family");
  });
});
