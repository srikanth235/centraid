import { describe, expect, it, vi } from "vitest";

import upload from "./upload.ts";

const VAULT_CTX_KEY = "vault";

function ctxWith(invoke: (call: unknown) => unknown) {
  return {
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    app: { id: "photos", dir: "" },
    ctx: {
      fetch: vi.fn<() => Promise<Response>>(),
      abortSignal: new AbortController().signal,
      [VAULT_CTX_KEY]: {
        invoke: vi.fn<(call: unknown) => Promise<unknown>>((call) =>
          Promise.resolve(invoke(call))
        ),
      },
      time: { now: () => new Date().toISOString() } as unknown,
    },
  };
}

describe("photos upload action", () => {
  it("forwards every optional field the schema declares", async () => {
    let seen: { input?: Record<string, unknown> } = {};
    const args = ctxWith((call) => {
      seen = call as { input?: Record<string, unknown> };
      return {
        status: "executed",
        output: { asset_id: "a1", content_id: "c1" },
      };
    });
    await upload({
      ...args,
      body: {
        staged_sha: "a".repeat(64),
        kind: "video",
        captured_at: "2026-08-01T00:00:00Z",
        tz_offset_min: -420,
        capture_group_id: "live:device-123",
        source_asset_id: "still-asset-id",
        title: "IMG_1234.MOV",
        width: 1920,
        height: 1080,
        duration_s: 3.2,
        phash: "abcd1234",
        thumbhash: "AAAA",
      },
    } as never);
    expect(seen.input).toMatchObject({
      staged_sha: "a".repeat(64),
      kind: "video",
      captured_at: "2026-08-01T00:00:00Z",
      tz_offset_min: -420,
      capture_group_id: "live:device-123",
      source_asset_id: "still-asset-id",
      title: "IMG_1234.MOV",
      width: 1920,
      height: 1080,
      duration_s: 3.2,
      phash: "abcd1234",
      thumbhash: "AAAA",
    });
  });

  it("omits every optional field an ordinary upload carries none of", async () => {
    let seen: { input?: Record<string, unknown> } = {};
    const args = ctxWith((call) => {
      seen = call as { input?: Record<string, unknown> };
      return {
        status: "executed",
        output: { asset_id: "a1", content_id: "c1" },
      };
    });
    await upload({
      ...args,
      body: { staged_sha: "b".repeat(64), kind: "photo" },
    } as never);
    expect(seen.input).toStrictEqual({
      staged_sha: "b".repeat(64),
      kind: "photo",
    });
  });
});
