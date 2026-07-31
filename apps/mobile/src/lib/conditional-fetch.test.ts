import { describe, expect, test } from "vitest";

import { ConditionalBodyCache } from "./conditional-fetch";

interface Call {
  href: string;
  init: RequestInit;
}

function recorder(reply: (call: Call, index: number) => Response): {
  send: (href: string, init: RequestInit) => Promise<Response>;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    send: (href, init) => {
      calls.push({ href, init });
      return Promise.resolve(reply({ href, init }, calls.length - 1));
    },
  };
}

function validator(call: Call): string | undefined {
  const headers = call.init.headers as Record<string, string> | undefined;
  return headers?.["if-none-match"];
}

describe(ConditionalBodyCache, () => {
  test("revalidates with the stored ETag and reuses the body on 304", async () => {
    const cache = new ConditionalBodyCache();
    const { send, calls } = recorder((call) =>
      validator(call)
        ? new Response(null, { status: 304 })
        : new Response('{"apps":1}', {
            status: 200,
            headers: { etag: 'W/"v1"' },
          })
    );

    const first = await cache.fetch("/_apps", { method: "GET" }, send);
    expect(first).toMatchObject({ body: '{"apps":1}', reused: false });
    expect(validator(calls[0]!)).toBeUndefined();

    const second = await cache.fetch("/_apps", { method: "GET" }, send);
    expect(second).toMatchObject({
      body: '{"apps":1}',
      reused: true,
      ok: true,
    });
    expect(validator(calls[1]!)).toBe('W/"v1"');
  });

  test("a changed resource replaces the cached body", async () => {
    const cache = new ConditionalBodyCache();
    const bodies = ['{"v":1}', '{"v":2}', '{"v":2}'];
    const etags = ['W/"1"', 'W/"2"', 'W/"2"'];
    const { send } = recorder((call, index) =>
      validator(call) === etags[index]
        ? new Response(null, { status: 304 })
        : new Response(bodies[index], {
            status: 200,
            headers: { etag: etags[index]! },
          })
    );

    expect((await cache.fetch("/n", {}, send)).body).toBe('{"v":1}');
    expect((await cache.fetch("/n", {}, send)).body).toBe('{"v":2}');
    const third = await cache.fetch("/n", {}, send);
    expect(third).toMatchObject({ body: '{"v":2}', reused: true });
  });

  test("a response without an ETag is never served from memory", async () => {
    const cache = new ConditionalBodyCache();
    const { send, calls } = recorder(
      () => new Response('{"v":1}', { status: 200 })
    );

    await cache.fetch("/plain", {}, send);
    const second = await cache.fetch("/plain", {}, send);
    expect(second.reused).toBe(false);
    expect(validator(calls[1]!)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test("an error response drops the entry and surfaces the status", async () => {
    const cache = new ConditionalBodyCache();
    let fail = false;
    const { send } = recorder(() =>
      fail
        ? new Response("nope", { status: 500 })
        : new Response('{"v":1}', { status: 200, headers: { etag: 'W/"1"' } })
    );

    await cache.fetch("/e", {}, send);
    fail = true;
    const failed = await cache.fetch("/e", {}, send);
    expect(failed).toMatchObject({ ok: false, status: 500, reused: false });
    expect(cache.size).toBe(0);
  });

  test("different scopes for one URL do not share a body", async () => {
    const cache = new ConditionalBodyCache();
    const { send, calls } = recorder((call) =>
      validator(call)
        ? new Response(null, { status: 304 })
        : new Response('{"scope":"x"}', {
            status: 200,
            headers: { etag: 'W/"1"' },
          })
    );

    await cache.fetch("/n", {}, send, "personal /n");
    const other = await cache.fetch("/n", {}, send, "family /n");
    expect(other.reused).toBe(false);
    expect(validator(calls[1]!)).toBeUndefined();
  });

  test("the cache stays bounded", async () => {
    const cache = new ConditionalBodyCache({ maxEntries: 3 });
    const { send } = recorder(
      () => new Response('{"v":1}', { status: 200, headers: { etag: 'W/"1"' } })
    );

    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        cache.fetch(`/n/${index}`, {}, send)
      )
    );
    expect(cache.size).toBe(3);
  });
});
