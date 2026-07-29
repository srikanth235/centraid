/*
 * Gateway log routes: the JSON tail + the replay-then-live SSE stream
 * over `GatewayLogStore`. Mock streaming req/res, same harness shape as
 * run-events-sse.test.ts.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { beforeEach, describe, expect, test } from "vitest";

import { GatewayLogStore } from "../serve/gateway-log-store.ts";
import type { GatewayLogEntry } from "../serve/gateway-log-store.ts";
import { makeLogsRouteHandler } from "./logs-routes.ts";
import { SseSubscriberCap } from "./sse-cap.ts";

let store: GatewayLogStore;
let handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

describe("logs-routes", () => {
  beforeEach(() => {
    store = new GatewayLogStore();
    handler = makeLogsRouteHandler(store);
  });

  interface MockClient {
    req: IncomingMessage;
    res: ServerResponse;
    status: () => number;
    body: () => string;
    header: (name: string) => string | undefined;
    events: () => GatewayLogEntry[];
    ended: () => boolean;
    close: () => void;
  }

  function client(url: string, method = "GET"): MockClient {
    const chunks: string[] = [];
    const headers = new Map<string, string>();
    let isEnded = false;
    let closeListener: (() => void) | undefined;
    const res = {
      writableEnded: false,
      statusCode: 0,
      writeHead(status: number) {
        this.statusCode = status;
        return this;
      },
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), value);
      },
      write(s: string) {
        chunks.push(s);
        return true;
      },
      end(s?: string) {
        if (s) chunks.push(s);
        isEnded = true;
        this.writableEnded = true;
      },
      on() {
        return this;
      },
    };
    const req = {
      method,
      url,
      on(event: string, fn: () => void) {
        if (event === "close") closeListener = fn;
        return this;
      },
    };
    return {
      req: req as unknown as IncomingMessage,
      res: res as unknown as ServerResponse,
      status: () => res.statusCode,
      body: () => chunks.join(""),
      header: (name: string) => headers.get(name.toLowerCase()),
      ended: () => isEnded,
      close: () => closeListener?.(),
      events: () =>
        chunks
          .join("")
          .split("\n\n")
          .map((frame) => frame.split("\n").find((l) => l.startsWith("data: ")))
          .filter((l): l is string => l !== undefined)
          .map((l) => JSON.parse(l.slice("data: ".length)) as GatewayLogEntry),
    };
  }

  test("ignores unrelated URLs", async () => {
    const c = client("/centraid/_gateway/info");
    await expect(handler(c.req, c.res)).resolves.toBe(false);
  });

  test("GET /centraid/_logs returns the buffered tail as JSON", async () => {
    store.append("info", "one");
    store.append("warn", "two");

    const c = client("/centraid/_logs");
    await expect(handler(c.req, c.res)).resolves.toBe(true);
    expect(c.status()).toBe(200);
    const parsed = JSON.parse(c.body()) as { entries: GatewayLogEntry[] };
    expect(parsed.entries.map((e) => e.message)).toStrictEqual(["one", "two"]);
  });

  test("JSON tail honors ?after= and ?limit= (newest win the cap)", async () => {
    for (let i = 1; i <= 5; i++) store.append("info", `line ${i}`);

    const after = client("/centraid/_logs?after=3");
    await handler(after.req, after.res);
    expect(
      (JSON.parse(after.body()) as { entries: GatewayLogEntry[] }).entries.map(
        (e) => e.message
      )
    ).toStrictEqual(["line 4", "line 5"]);

    const limited = client("/centraid/_logs?limit=2");
    await handler(limited.req, limited.res);
    expect(
      (
        JSON.parse(limited.body()) as { entries: GatewayLogEntry[] }
      ).entries.map((e) => e.message)
    ).toStrictEqual(["line 4", "line 5"]);
  });

  test("non-GET is a 405", async () => {
    const c = client("/centraid/_logs", "POST");
    await expect(handler(c.req, c.res)).resolves.toBe(true);
    expect(c.status()).toBe(405);
  });

  test("SSE replays the buffer then streams live entries", async () => {
    store.append("info", "boot line");

    const c = client("/centraid/_logs/events");
    await expect(handler(c.req, c.res)).resolves.toBe(true);
    expect(c.status()).toBe(200);

    // Replay landed, stream still open, subscriber registered.
    expect(c.events().map((e) => e.message)).toStrictEqual(["boot line"]);
    expect(c.ended()).toBe(false);
    expect(store.subscriberCount()).toBe(1);

    store.append("error", "live failure");
    const evs = c.events();
    expect(evs.map((e) => e.message)).toStrictEqual([
      "boot line",
      "live failure",
    ]);
    expect(evs[1]?.level).toBe("error");
    // seq-ordered, gapless.
    expect(evs.map((e) => e.seq)).toStrictEqual([1, 2]);
  });

  test("SSE ?after= skips already-seen entries on reconnect", async () => {
    store.append("info", "seen");
    store.append("info", "unseen");

    const c = client("/centraid/_logs/events?after=1");
    await handler(c.req, c.res);
    expect(c.events().map((e) => e.message)).toStrictEqual(["unseen"]);
  });

  test("client disconnect unsubscribes and ends the response", async () => {
    const c = client("/centraid/_logs/events");
    await handler(c.req, c.res);
    expect(store.subscriberCount()).toBe(1);

    c.close();
    expect(store.subscriberCount()).toBe(0);
    expect(c.ended()).toBe(true);

    // A line after disconnect reaches no one and doesn't throw.
    store.append("info", "after close");
  });

  // Issue #351: unbounded concurrent SSE subscribers is a fd-exhaustion risk.
  // A small cap (2) makes the "cap+1" scenario cheap to exercise directly.
  test("SSE subscribers past the cap get 503 + Retry-After; the count decrements on disconnect", async () => {
    const cap = new SseSubscriberCap(2);
    const capped = makeLogsRouteHandler(store, { subscriberCap: cap });

    const a = client("/centraid/_logs/events");
    const b = client("/centraid/_logs/events");
    await expect(capped(a.req, a.res)).resolves.toBe(true);
    await expect(capped(b.req, b.res)).resolves.toBe(true);
    expect(a.status()).toBe(200);
    expect(b.status()).toBe(200);
    expect(cap.current()).toBe(2);

    // The 3rd subscriber is over the cap — refused, never joins the stream.
    const c = client("/centraid/_logs/events");
    await expect(capped(c.req, c.res)).resolves.toBe(true);
    expect(c.status()).toBe(503);
    expect(c.header("Retry-After")).toBeDefined();
    const errBody = JSON.parse(c.body()) as { error: string };
    expect(errBody.error).toBe("sse_capacity");
    expect(c.ended()).toBe(true);
    expect(cap.current()).toBe(2); // the refusal never incremented the count

    // Disconnecting one live subscriber frees a slot for the next comer.
    a.close();
    expect(cap.current()).toBe(1);
    const d = client("/centraid/_logs/events");
    await expect(capped(d.req, d.res)).resolves.toBe(true);
    expect(d.status()).toBe(200);
    expect(cap.current()).toBe(2);
  });
});
