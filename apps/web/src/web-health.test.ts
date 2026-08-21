import { afterEach, describe, expect, it, vi } from "vitest";

import { healthSnapshot, resetHealthTracking } from "./web-health.js";
import type * as WebState from "./web-state.js";

const { gatewayJson, loadConnection, webGatewayId } = vi.hoisted(() => ({
  gatewayJson: vi.fn<typeof WebState.gatewayJson>(),
  loadConnection: vi.fn<typeof WebState.loadConnection>(),
  webGatewayId: vi.fn<typeof WebState.webGatewayId>(),
}));

vi.mock(import("./web-state.js"), () => ({
  // `vi.fn<typeof gatewayJson>` is not assignable to the generic itself:
  // the mock's return type collapses to `Promise<unknown>`, which is not
  // `Promise<T>`. The wrapper keeps the hoisted mock and satisfies tsc.
  gatewayJson: ((pathname: string, init?: RequestInit) =>
    gatewayJson(pathname, init)) as typeof WebState.gatewayJson,
  loadConnection,
  webGatewayId,
}));

describe("web-health", () => {
  afterEach(() => {
    resetHealthTracking();
  });

  it("keeps the session window across polls until reset", async () => {
    loadConnection.mockReturnValue({ label: "Home" } as ReturnType<
      typeof WebState.loadConnection
    >);
    webGatewayId.mockReturnValue("gw-1");
    gatewayJson.mockResolvedValue({
      uptimeMs: 1_000,
      startedAt: new Date(0).toISOString(),
      status: "ok",
      components: [],
    });

    const first = await healthSnapshot();
    const second = await healthSnapshot();
    expect(first.checksTotal).toBe(1);
    expect(second.checksTotal).toBe(2);
    expect(second.samples).toHaveLength(2);

    resetHealthTracking();
    const third = await healthSnapshot();
    expect(third.checksTotal).toBe(1);
    expect(third.samples).toHaveLength(1);
  });
});
