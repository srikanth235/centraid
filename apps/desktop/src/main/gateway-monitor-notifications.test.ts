import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GatewayProbe } from "./gateway-monitor-core.js";
import type { OutageLogEvent } from "./gateway-outage-log-core.js";

/**
 * Gateway health never reaches Notifications (#665). Dual-write produces a
 * card the owner cannot resolve (#647). Pin both halves: a real transition
 * lands in the durable log, and the tick performs no HTTP write beyond the
 * probe. Assert on `fetch` so a reintroduced projection is caught however
 * it is spelled.
 */
const fixture = vi.hoisted(() => ({
  persisted: [] as OutageLogEvent[],
  fetched: [] as string[],
  probe: { at: 0, ok: true } as GatewayProbe,
}));

vi.mock(import("electron"), () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  } as unknown as typeof import("electron").BrowserWindow,
  Notification: {
    isSupported: () => false,
  } as unknown as typeof import("electron").Notification,
}));
vi.mock(import("./app-chrome.js"), () => ({
  setTrayGatewayRunning: () => undefined,
}));
vi.mock(import("./power-context-push.js"), () => ({
  pushPowerContext: async () => undefined,
}));
vi.mock(import("./local-gateway.js"), () => ({
  getLocalGatewaySupervisorState: () => ({
    failures: [],
    attempt: 0,
    loopBroken: false,
  }),
  reviveLocalGatewayIfDead: async () => false,
}));
vi.mock(import("./gateway-monitor-probe.js"), () => ({
  probeGateway: async () => fixture.probe,
}));
vi.mock(import("./gateway-outage-log.js"), () => ({
  loadOutageLog: () => [],
  persistOutageEvents: (
    existing: readonly OutageLogEvent[],
    events: OutageLogEvent[]
  ) => {
    fixture.persisted.push(...events);
    return [...existing, ...events];
  },
}));
vi.mock(import("./settings.js"), () => ({
  loadSettings: async () => ({
    activeGatewayId: "local",
    activeGatewayKind: "local" as const,
    activeGatewayLabel: "Local",
    activeProfileDisplayName: "Local",
    activeProfileAvatarColor: "#336699",
    activeVaultId: "vault-a",
    gatewayUrl: "http://127.0.0.1:17832",
    gatewayToken: "loopback-token",
    gatewayAlertsEnabled: true,
    onboardingCompletedAt: "2026-07-01T00:00:00.000Z",
  }),
}));

const T0 = Date.UTC(2026, 6, 31, 12, 0, 0);

describe("gateway monitor: health does not project into the Notifications", () => {
  beforeEach(() => {
    vi.resetModules();
    fixture.persisted = [];
    fixture.fetched = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      fixture.fetched.push(String(input));
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
  });

  it("persists a real down transition durably and writes nothing to the Notifications", async () => {
    const monitor = await import("./gateway-monitor.js");

    fixture.probe = { at: T0, ok: true, latencyMs: 3 };
    await monitor.getGatewayRuntimeSnapshot();
    fixture.probe = { at: T0 + 5000, ok: false, detail: "fetch failed" };
    monitor.nudgeGatewayMonitor();
    await vi.waitFor(() => expect(fixture.persisted).toHaveLength(1));
    const snapshot = await monitor.getGatewayRuntimeSnapshot();
    monitor.stopGatewayMonitor();

    expect(fixture.persisted.map((e) => e.kind)).toStrictEqual(["down"]);
    expect(fixture.persisted[0]?.detail).toBe("fetch failed");
    expect(snapshot.alertHistory.map((e) => e.kind)).toStrictEqual(["down"]);

    expect(fixture.fetched).toStrictEqual([]);
  });
});
