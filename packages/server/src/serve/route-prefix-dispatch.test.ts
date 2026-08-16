import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, test, vi } from "vitest";

import {
  createRoutePrefixDispatch,
  forRoutePrefixes,
} from "./build-gateway.js";
import type { RouteHandler } from "./build-gateway.js";

describe("route-prefix-dispatch", () => {
  test("prefix table parses once and invokes only the most-specific matching family (#456 R1)", async () => {
    const generic = vi.fn<RouteHandler>(async () => true);
    const specific = vi.fn<RouteHandler>(async () => true);
    const disjoint = vi.fn<RouteHandler>(async () => true);
    const dispatch = createRoutePrefixDispatch([
      forRoutePrefixes("/centraid/_gateway", generic),
      forRoutePrefixes("/centraid/_gateway/health", specific),
      forRoutePrefixes("/centraid/_vault/blobs", disjoint),
    ]);
    const res = {} as ServerResponse;
    let reads = 0;
    const req = {} as IncomingMessage;
    Object.defineProperty(req, "url", {
      get: () => {
        reads += 1;
        return "/centraid/_gateway/health/deep?full=1";
      },
    });

    await expect(dispatch(req, res)).resolves.toBe(true);
    expect(reads).toBe(1);
    expect(specific).toHaveBeenCalledOnce();
    expect(generic).not.toHaveBeenCalled();
    expect(disjoint).not.toHaveBeenCalled();
  });

  test("prefix table falls through matching handlers without walking disjoint families", async () => {
    const first = vi.fn<RouteHandler>(async () => false);
    const second = vi.fn<RouteHandler>(async () => true);
    const disjoint = vi.fn<RouteHandler>(async () => true);
    const dispatch = createRoutePrefixDispatch([
      forRoutePrefixes("/centraid/_apps", first),
      forRoutePrefixes("/centraid/_apps", second),
      forRoutePrefixes("/centraid/_automations", disjoint),
    ]);
    const res = {} as ServerResponse;

    await expect(
      dispatch({ url: "/centraid/_apps/todos?asset=1" } as IncomingMessage, res)
    ).resolves.toBe(true);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(disjoint).not.toHaveBeenCalled();
  });
});
