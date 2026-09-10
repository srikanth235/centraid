/*
 * THE BOUND ON A GATEWAY'S SSE STREAMS (#351 Tier 4, #1014 V17).
 *
 * The cap was per PROCESS and nothing else, so one device opening the whole
 * allowance took every slot and every other seat in the household got
 * `503 sse_capacity` — with, before #1014's periodic pull, no delivery path
 * left to fall back on. Fairness is the second bound, not a replacement for
 * the first: both still refuse, and both refuse with a Retry-After.
 */

import type { ServerResponse } from "node:http";

import { describe, expect, test } from "vitest";

import { SSE_PER_DEVICE_MAX, SseSubscriberCap } from "./sse-cap.js";

interface Recorded {
  res: ServerResponse;
  status: () => number;
  body: () => string;
  headers: Record<string, string>;
}

function response(): Recorded {
  const headers: Record<string, string> = {};
  const state = { status: 200, body: "" };
  const res = {
    get statusCode() {
      return state.status;
    },
    set statusCode(value: number) {
      state.status = value;
    },
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    },
    end: (value?: string) => {
      if (value !== undefined) state.body += value;
    },
    writableEnded: false,
  } as unknown as ServerResponse;
  return {
    res,
    status: () => state.status,
    body: () => state.body,
    headers,
  };
}

describe("the SSE subscriber cap", () => {
  test("one device cannot take more than its share", () => {
    const cap = new SseSubscriberCap(32);
    const held = Array.from({ length: SSE_PER_DEVICE_MAX }, () =>
      cap.admit(response().res, "phone-a")
    );
    expect(held.every((release) => release !== undefined)).toBe(true);

    const refused = response();
    expect(cap.admit(refused.res, "phone-a")).toBeUndefined();
    expect(refused.status()).toBe(503);
    expect(refused.body()).toContain("sse_capacity");
    expect(
      refused.headers["retry-after"],
      "a client told to back off with no delay reconnects at once"
    ).toBeDefined();

    // Another device is unaffected: this is fairness, not a global squeeze.
    expect(cap.admit(response().res, "phone-b")).toBeDefined();
    expect(cap.currentFor("phone-a")).toBe(SSE_PER_DEVICE_MAX);

    held[0]?.();
    expect(cap.currentFor("phone-a")).toBe(SSE_PER_DEVICE_MAX - 1);
    expect(cap.admit(response().res, "phone-a")).toBeDefined();
  });

  test("releasing is idempotent and the process cap still bites", () => {
    const cap = new SseSubscriberCap(1);
    const release = cap.admit(response().res, "phone-a");
    expect(release).toBeDefined();
    const refused = response();
    expect(cap.admit(refused.res, "phone-b")).toBeUndefined();
    expect(refused.status()).toBe(503);

    release?.();
    release?.();
    expect(cap.current()).toBe(0);
    expect(cap.currentFor("phone-a")).toBe(0);
  });

  test("a stream with no device identity is bounded by the process cap alone", () => {
    const cap = new SseSubscriberCap(3);
    expect(cap.admit(response().res)).toBeDefined();
    expect(cap.admit(response().res)).toBeDefined();
    expect(cap.admit(response().res)).toBeDefined();
    expect(cap.admit(response().res)).toBeUndefined();
  });
});
