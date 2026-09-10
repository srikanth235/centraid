import { describe, expect, test, vi } from "vitest";

import { NativeMultiplexChangeFeed } from "./native-multiplex-change-feed";

vi.mock(import("expo/fetch"), () => ({
  fetch: vi.fn<(typeof import("expo/fetch"))["fetch"]>(),
}));

function scopeFrame(vaultId: string, changeCount: number, epoch = "1"): string {
  return `event: scope\ndata: ${JSON.stringify({
    vaultId,
    event: "change",
    data: {
      changes: Array.from({ length: changeCount }, (_unused, index) => ({
        cursor: { epoch, seq: index + 1 },
        entity: "media.asset",
        rowId: `asset-${index}`,
        op: "insert",
        changedAt: "2026-08-27T09:00:00.000Z",
      })),
      cursor: { epoch, seq: changeCount },
    },
  })}\n\n`;
}

/** The cursor the stream URL asks this scope to resume from. */
function askedCursor(url: string, vaultId: string): unknown {
  const mounts = JSON.parse(
    new URL(url).searchParams.get("mounts") ?? "[]"
  ) as Array<{ vaultId: string; cursor: unknown }>;
  return mounts.find((mount) => mount.vaultId === vaultId)?.cursor;
}

function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe(NativeMultiplexChangeFeed, () => {
  test("one revoked frame drops that scope and leaves the others mounted", async () => {
    let resolveRevoked = (_vaultId: string): void => undefined;
    const revoked = new Promise<string>((resolve) => {
      resolveRevoked = resolve;
    });
    const requested: string[] = [];
    const feed = new NativeMultiplexChangeFeed({
      gatewayAuth: { baseUrl: "http://gateway", gatewayId: "gateway-1" },
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
    await settle();
    feed.close();
    const lastMounts = new URL(requested.at(-1)!).searchParams.get("mounts");
    expect(lastMounts).toContain("personal");
    expect(lastMounts).not.toContain("family");
  });

  test("a thousand-change frame costs one freshness signal", async () => {
    // THE REGRESSION THIS PINS (#880 W3.2). Every change used to call
    // `onScopeUpdated`, which in ReplicaProvider is an AsyncStorage write plus
    // a context rebuild — one busy frame meant a thousand re-renders of every
    // `useReplica()` consumer. Only the newest cursor of a frame ever mattered.
    const updated: string[] = [];
    const changes: string[] = [];
    const feed = new NativeMultiplexChangeFeed({
      gatewayAuth: { baseUrl: "http://gateway", gatewayId: "gateway-1" },
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

    // Every change still reaches the session — the batching is about the
    // signal's cost, never about dropping a row.
    expect(
      changes.filter((type) => type === "centraid:vault-change")
    ).toHaveLength(1_000);
    expect(updated).toStrictEqual(["personal"]);
    feed.close();
  });

  // #1014, C18. The feed kept its own durable cursor, keyed by
  // `gatewayId ?? baseUrl` — a value `updateGatewayBase` mutates mid-session —
  // and nothing ever reconciled it with the seat's `applied_seq`. There is one
  // cursor on this phone and this is where the feed reads it.
  test("resumes from the seat's applied position, not from a cursor of its own", async () => {
    const requested: string[] = [];
    let applied = 41;
    const feed = new NativeMultiplexChangeFeed({
      gatewayAuth: { baseUrl: "http://gateway", gatewayId: "gateway-1" },
      minReconnectMs: 60_000,
      maxReconnectMs: 60_000,
      resumeFrom: () => ({ epoch: "e1", applied }),
      streamFetch: async (input) => {
        requested.push(String(input));
        return new Response("", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }) as never;
      },
    });
    const personal = feed.scope("personal");
    personal.subscribe(() => undefined);
    personal.setActive(true);
    await settle();
    expect(askedCursor(requested.at(-1)!, "personal")).toStrictEqual({
      epoch: "e1",
      seq: 41,
    });

    // The seat caught up between two connects: the NEXT stream asks from
    // where the file now stands, never from the position the feed remembered.
    applied = 99;
    personal.setActive(false);
    personal.setActive(true);
    await settle();
    expect(askedCursor(requested.at(-1)!, "personal")).toStrictEqual({
      epoch: "e1",
      seq: 99,
    });
    feed.close();
  });

  // #1014, C19. `advanceCursor` took any cursor whose epoch merely DIFFERED,
  // so one stray frame moved the scope onto an epoch nobody asked for and
  // every later frame of the real one was then read as "different" too.
  test("ignores an epoch it did not ask for until the gateway says rebootstrap", async () => {
    const requested: string[] = [];
    const body = `${scopeFrame("personal", 3, "e1")}${scopeFrame("personal", 2, "e9")}`;
    const feed = new NativeMultiplexChangeFeed({
      gatewayAuth: { baseUrl: "http://gateway", gatewayId: "gateway-1" },
      minReconnectMs: 60_000,
      maxReconnectMs: 60_000,
      streamFetch: async (input) => {
        requested.push(String(input));
        return new Response(requested.length === 1 ? body : "", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }) as never;
      },
    });
    const personal = feed.scope("personal");
    personal.subscribe(() => undefined);
    personal.setActive(true);
    await settle();

    personal.setActive(false);
    personal.setActive(true);
    await settle();
    // `e1:3`, the last frame of the epoch this scope is actually on — not
    // `e9:2`, which arrived without a rebootstrap verdict in front of it.
    expect(askedCursor(requested.at(-1)!, "personal")).toStrictEqual({
      epoch: "e1",
      seq: 3,
    });
    feed.close();
  });

  test("reports the gateway going silent, so a still-connected phone is told", async () => {
    // THE REGRESSION THIS PINS (#903): killing a gateway moves no radio, so
    // the feed is the only thing that can notice.
    const outcomes: boolean[] = [];
    let answer = true;
    const feed = new NativeMultiplexChangeFeed({
      gatewayAuth: { baseUrl: "http://gateway", gatewayId: "gateway-1" },
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
