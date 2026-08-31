import { describe, expect, test, vi } from "vitest";

import { seedDemoAndRefreshReplica } from "./seed-demo-and-refresh-replica";

describe(seedDemoAndRefreshReplica, () => {
  test("seeds every advertised app, then rebuilds the replica twice", async () => {
    const order: string[] = [];
    const fetchJson = vi.fn(async (url: string, init: RequestInit) => {
      order.push(`${init.method ?? "GET"} ${url}`);
      if (url.endsWith("/_vault/demo"))
        return { apps: [{ appId: "docs", seedable: true }] };
      return { ok: true };
    });
    const replica = {
      refresh: vi.fn(async () => order.push("refresh")),
      session: {
        rebootstrap: vi.fn(async () => order.push("rebootstrap")),
      },
    };

    await seedDemoAndRefreshReplica({
      requireGatewayBase: async () => "http://gateway.test",
      fetchJson,
      apiHeaders: () => ({ authorization: "Bearer t" }),
      replica,
      wait: async (ms) => order.push(`wait:${ms}`),
    });

    expect(order).toStrictEqual([
      "GET http://gateway.test/centraid/_vault/demo",
      "POST http://gateway.test/centraid/_vault/demo/docs",
      "refresh",
      "rebootstrap",
      "wait:500",
      "rebootstrap",
    ]);
    expect(replica.session.rebootstrap).toHaveBeenNthCalledWith(1, {
      force: true,
    });
    expect(replica.session.rebootstrap).toHaveBeenNthCalledWith(2, {
      force: true,
    });
  });

  test("a failed refresh still rebuilds, while a failed app seed is isolated", async () => {
    const seeded: string[] = [];
    let app = 0;
    await seedDemoAndRefreshReplica({
      requireGatewayBase: async () => "http://gateway.test",
      fetchJson: async (url, init) => {
        if (url.endsWith("/_vault/demo"))
          return {
            apps: [
              { appId: "docs", seedable: true },
              { appId: "notes", seedable: true },
            ],
          };
        app += 1;
        if (app === 1) throw new Error("one seed failed");
        seeded.push(`${init.method} ${url}`);
        return {};
      },
      apiHeaders: () => ({}),
      replica: {
        refresh: async () => {
          throw new Error("stale reachability");
        },
        session: {
          rebootstrap: async () => undefined,
        },
      },
      wait: async () => undefined,
    });
    expect(seeded).toStrictEqual([
      "POST http://gateway.test/centraid/_vault/demo/notes",
    ]);
  });
});
