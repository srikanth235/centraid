import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GatewayProbe } from "./gateway-monitor-core.js";
import type { OutageLogEvent } from "./gateway-outage-log-core.js";

/**
 * Gateway health never reaches the Notifications (#665).
 *
 * Dual-writing a persisted transition into the vault Notifications produces a
 * card the owner can never resolve by acting on it: marking a persistent
 * "degraded" read does not un-degrade anything, so it simply comes back
 * (#647). Health is STATUS — it belongs
 * to the Gateway page (Overview card, Components tab, durable Alerts history)
 * and the threshold-gated OS notification.
 *
 * So the contract pinned here is BOTH halves at once, because either alone is
 * satisfiable by a bug: a real transition still lands in the durable log (the
 * Alerts tab's only source), and the tick performs no HTTP write of any kind
 * beyond the health probe itself. Asserting on `fetch` rather than on a removed
 * function is deliberate — a reintroduced projection would be caught however it
 * is spelled.
 */

const fixture = vi.hoisted(() => ({
  /** Everything `persistOutageEvents` was handed, flattened. */
  persisted: [] as OutageLogEvent[],
  /** Every URL the tick fetched, other than the probe (which is mocked out). */
  fetched: [] as string[],
  probe: { at: 0, ok: true } as GatewayProbe,
}));

// Only the two surfaces gateway-monitor.ts reaches for. `Notification` reports
// unsupported so no OS notification is constructed — this suite is about the
// durable log and the absence of HTTP, not about alerting.
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
  // A gateway that has never failed to start: no loop breaker, so the tick
  // takes the ordinary probe path.
  getLocalGatewaySupervisorState: () => ({
    failures: [],
    attempt: 0,
    loopBroken: false,
  }),
  // "Nothing to revive" — the daemon is not being resurrected in this suite.
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
// A settled install (`onboardingCompletedAt` present, so alerting is live) with
// an active vault and a reachable gateway URL — precisely the configuration a
// Notifications projection would require, so its absence here is a real signal.
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

    // Tick 1: healthy, so the monitor has a real `up` to transition away from
    // (a cold `unknown → down` is the boot-phase case, deliberately silent).
    fixture.probe = { at: T0, ok: true, latencyMs: 3 };
    await monitor.getGatewayRuntimeSnapshot();
    // Tick 2: the gateway goes away for real.
    fixture.probe = { at: T0 + 5000, ok: false, detail: "fetch failed" };
    // `nudgeGatewayMonitor` deliberately voids its tick promise (it is a
    // fire-and-forget IPC nudge), so wait on the observable outcome instead.
    monitor.nudgeGatewayMonitor();
    await vi.waitFor(() => expect(fixture.persisted).toHaveLength(1));
    const snapshot = await monitor.getGatewayRuntimeSnapshot();
    monitor.stopGatewayMonitor();

    // Half one: the transition IS durable, and reaches the Alerts tab.
    expect(fixture.persisted.map((e) => e.kind)).toStrictEqual(["down"]);
    expect(fixture.persisted[0]?.detail).toBe("fetch failed");
    expect(snapshot.alertHistory.map((e) => e.kind)).toStrictEqual(["down"]);

    // Half two: no Notifications write, by any spelling. The probe itself is mocked
    // out, so any fetch at all would be a Notifications projection.
    expect(fixture.fetched).toStrictEqual([]);
  });
});
