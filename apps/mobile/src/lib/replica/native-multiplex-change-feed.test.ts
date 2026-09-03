import { describe, expect, test, vi } from "vitest";

import type { AsyncStorageLike } from "./native-change-feed";
import { NativeMultiplexChangeFeed } from "./native-multiplex-change-feed";

vi.mock(import("expo/fetch"), () => ({
  fetch: vi.fn<(typeof import("expo/fetch"))["fetch"]>(),
}));

function memoryStorage(): AsyncStorageLike & {
  values: Map<string, string>;
  writes: string[];
} {
  const values = new Map<string, string>();
  const writes: string[] = [];
  return {
    values,
    writes,
    getItem: (key) => Promise.resolve(values.get(key) ?? null),
    setItem: (key, value) => {
      values.set(key, value);
      writes.push(key);
      return Promise.resolve();
    },
    removeItem: (key) => {
      values.delete(key);
      return Promise.resolve();
    },
  };
}

function scopeFrame(vaultId: string, changeCount: number): string {
  return `event: scope\ndata: ${JSON.stringify({
    vaultId,
    event: "change",
    data: {
      changes: Array.from({ length: changeCount }, (_unused, index) => ({
        cursor: { epoch: "1", seq: index + 1 },
        entity: "media.asset",
        rowId: `asset-${index}`,
        op: "insert",
        changedAt: "2026-08-27T09:00:00.000Z",
      })),
      cursor: { epoch: "1", seq: changeCount },
    },
  })}\n\n`;
}

function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
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
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    feed.close();
    expect(
      [...storage.values.keys()].some((key) => key.includes("family"))
    ).toBe(false);
    const lastMounts = new URL(requested.at(-1)!).searchParams.get("mounts");
    expect(lastMounts).toContain("personal");
    expect(lastMounts).not.toContain("family");
  });

  test("a thousand-change frame costs one cursor write and one freshness signal", async () => {
    const storage = memoryStorage();
    const updated: string[] = [];
    const changes: string[] = [];
    const feed = new NativeMultiplexChangeFeed({
      gatewayAuth: { baseUrl: "http://gateway", gatewayId: "gateway-1" },
      storage,
      minReconnectMs: 60_000,
      maxReconnectMs: 60_000,
      streamFetch: async () =>
        new Response(scopeFrame("personal", 1_000), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }) as never,
      onScopeUpdated: (vaultId) => updated.push(vaultId),
    });
    const personal = feed.scope("personal");
    personal.subscribe((message) => changes.push(message.type));
    personal.setActive(true);
    await settle();

    expect(
      changes.filter((type) => type === "centraid:vault-change")
    ).toHaveLength(1_000);
    expect(updated).toStrictEqual(["personal"]);
    expect(storage.writes).toStrictEqual([]);

    feed.close();
    await settle();
    expect(storage.writes).toHaveLength(1);
    expect(JSON.parse(storage.values.get(storage.writes[0]!)!)).toStrictEqual({
      epoch: "1",
      seq: 1_000,
    });
  });

  test("backgrounding a scope lands its cursor before the stream drops", async () => {
    const storage = memoryStorage();
    const feed = new NativeMultiplexChangeFeed({
      gatewayAuth: { baseUrl: "http://gateway", gatewayId: "gateway-1" },
      storage,
      minReconnectMs: 60_000,
      maxReconnectMs: 60_000,
      streamFetch: async () =>
        new Response(scopeFrame("personal", 12), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }) as never,
    });
    const personal = feed.scope("personal");
    personal.subscribe(() => undefined);
    personal.setActive(true);
    await settle();
    expect(storage.writes).toStrictEqual([]);

    personal.setActive(false);
    await settle();
    expect(storage.writes).toHaveLength(1);
    expect(JSON.parse(storage.values.get(storage.writes[0]!)!)).toMatchObject({
      seq: 12,
    });
    feed.close();
  });

  test("a revoked scope's debounced cursor never lands after the purge", async () => {
    const storage = memoryStorage();
    const feed = new NativeMultiplexChangeFeed({
      gatewayAuth: { baseUrl: "http://gateway", gatewayId: "gateway-1" },
      storage,
      minReconnectMs: 60_000,
      maxReconnectMs: 60_000,
      streamFetch: async (input) => {
        const mounts = new URL(String(input)).searchParams.get("mounts") ?? "";
        return new Response(
          mounts.includes("family")
            ? `${scopeFrame("family", 40)}event: scope\ndata: ${JSON.stringify({
                vaultId: "family",
                event: "revoked",
                data: { reason: "device-access-changed" },
              })}\n\n`
            : "",
          { status: 200, headers: { "content-type": "text/event-stream" } }
        ) as never;
      },
    });
    const family = feed.scope("family");
    family.subscribe(() => undefined);
    family.setActive(true);
    await settle();

    feed.close();
    await settle();
    expect([...storage.values.keys()]).toStrictEqual([]);
  });
  test("reports the gateway going silent, so a still-connected phone is told", async () => {
    const outcomes: boolean[] = [];
    let answer = true;
    const feed = new NativeMultiplexChangeFeed({
      gatewayAuth: { baseUrl: "http://gateway", gatewayId: "gateway-1" },
      storage: memoryStorage(),
      minReconnectMs: 60_000,
      maxReconnectMs: 60_000,
      streamFetch: async () => {
        if (!answer) throw new Error("connection refused");
        return new Response("", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }) as never;
      },
      onStreamOutcome: (reachable) => outcomes.push(reachable),
    });
    const personal = feed.scope("personal");
    personal.subscribe(() => undefined);
    personal.setActive(true);
    await settle();
    expect(outcomes).toStrictEqual([true]);

    answer = false;
    personal.setActive(false);
    personal.setActive(true);
    await settle();
    expect(outcomes.at(-1)).toBe(false);
    feed.close();
  });
});
