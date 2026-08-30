import { describe, expect, test, vi } from "vitest";

import { seedDemoAndRefreshReplica } from "./seed-demo-and-refresh-replica";

describe(seedDemoAndRefreshReplica, () => {
  test("POSTs the vault demo once, then refresh + rebootstrap, wait, rebootstrap", async () => {
    const order: string[] = [];
    const fetchJson = vi.fn<
      (url: string, init: { method: string }) => Promise<unknown>
    >(async (url, init) => {
      order.push(`${init.method} ${url}`);
      return { seeded: ["photos"], skipped: [] };
    });
    const replica = {
      refresh: vi.fn<() => Promise<void>>(async () => {
        order.push("refresh");
      }),
      session: {
        rebootstrap: vi.fn<() => Promise<void>>(async () => {
          order.push("rebootstrap");
        }),
      },
    };
    const wait = vi.fn<(ms: number) => Promise<void>>(async (ms) => {
      order.push(`wait:${ms}`);
    });

    await seedDemoAndRefreshReplica({
      requireGatewayBase: async () => "http://gateway.test",
      fetchJson,
      apiHeaders: () => ({ authorization: "Bearer t" }),
      replica,
      wait,
    });

    expect(order).toStrictEqual([
      "POST http://gateway.test/centraid/_vault/demo",
      "refresh",
      "rebootstrap",
      "wait:500",
      "rebootstrap",
    ]);
    expect(replica.session.rebootstrap).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(500);
  });

  test("a failed reachability refresh still rebootstraps the replica", async () => {
    const order: string[] = [];
    await seedDemoAndRefreshReplica({
      requireGatewayBase: async () => "http://gateway.test",
      fetchJson: async () => ({}),
      apiHeaders: () => ({}),
      replica: {
        refresh: async () => {
          order.push("refresh");
          throw new Error("tunnel probe lost the race");
        },
        session: {
          rebootstrap: async () => {
            order.push("rebootstrap");
          },
        },
      },
      wait: async () => {
        order.push("wait");
      },
    });
    expect(order).toStrictEqual([
      "refresh",
      "rebootstrap",
      "wait",
      "rebootstrap",
    ]);
  });

  test("does not rebootstrap when the demo POST never lands", async () => {
    const rebootstrap = vi.fn<() => Promise<void>>(async () => undefined);
    await expect(
      seedDemoAndRefreshReplica({
        requireGatewayBase: async () => "http://gateway.test",
        fetchJson: async () => {
          throw new Error("gateway dead");
        },
        apiHeaders: () => ({}),
        replica: { session: { rebootstrap } },
        wait: async () => undefined,
      })
    ).rejects.toThrow(/gateway dead/u);
    expect(rebootstrap).not.toHaveBeenCalled();
  });
});
