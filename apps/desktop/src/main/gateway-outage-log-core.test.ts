// governance: allow-repo-hygiene file-size-limit one suite per pure core module (#665): NDJSON round-trip, capping, and outage derivation are one behavioural surface — splitting the suite would split the invariants that only fail together
import { describe, expect, it } from "vitest";

import { initialRuntimeState } from "./gateway-monitor-core.js";
import type { GatewayRuntimeState } from "./gateway-monitor-core.js";
import {
  capOutageLog,
  deriveOutageEvents,
  formatOutageLogFile,
  OUTAGE_LOG_CAP,
  parseOutageLogFile,
} from "./gateway-outage-log-core.js";
import type { OutageLogEvent } from "./gateway-outage-log-core.js";

const T0 = Date.UTC(2026, 6, 11, 12, 0, 0);

function event(over: Partial<OutageLogEvent> = {}): OutageLogEvent {
  return {
    at: T0,
    kind: "down",
    gatewayId: "local",
    gatewayLabel: "Local",
    ...over,
  };
}

function eventLine(e: OutageLogEvent): string {
  return `${JSON.stringify(e)}\n`;
}

describe("formatOutageLogFile / parseOutageLogFile", () => {
  it("round-trips one event through NDJSON", () => {
    const e = event({ detail: "fetch failed" });
    const raw = formatOutageLogFile([e]);
    expect(raw.endsWith("\n")).toBe(true);
    expect(parseOutageLogFile(raw)).toStrictEqual([e]);
  });

  it("round-trips multiple events in order", () => {
    const events = [
      event({ at: T0, kind: "down" }),
      event({ at: T0 + 1000, kind: "recovered", durationMs: 1000 }),
    ];
    expect(parseOutageLogFile(formatOutageLogFile(events))).toStrictEqual(
      events
    );
  });

  it("skips blank lines", () => {
    const raw = `${eventLine(event())}\n\n${eventLine(event({ at: T0 + 1 }))}`;
    expect(parseOutageLogFile(raw)).toHaveLength(2);
  });

  it("skips a torn/corrupt line without losing the rest", () => {
    const good = eventLine(event());
    const raw = `${good}{"at": broken json\n${eventLine(event({ at: T0 + 1 }))}`;
    expect(parseOutageLogFile(raw)).toHaveLength(2);
  });

  it("skips a well-formed JSON value missing required fields", () => {
    const raw = `${JSON.stringify({ at: T0, kind: "down" })}\n${eventLine(event({ at: T0 + 1 }))}`;
    expect(parseOutageLogFile(raw)).toHaveLength(1);
  });

  it("skips an event with an unrecognized kind", () => {
    const raw = `${JSON.stringify({ ...event(), kind: "bogus" })}\n${eventLine(event({ at: T0 + 1 }))}`;
    expect(parseOutageLogFile(raw)).toHaveLength(1);
  });

  it("empty input parses to no events", () => {
    expect(parseOutageLogFile("")).toStrictEqual([]);
  });

  it("a log with no header line still yields its events", () => {
    const raw = [eventLine(event()), eventLine(event({ at: T0 + 1 }))].join("");
    expect(parseOutageLogFile(raw)).toHaveLength(2);
  });

  it("reads an existing schema-3 log, ignoring its legacy projection marks", () => {
    const events = [
      event({ at: T0 }),
      event({ at: T0 + 1, kind: "recovered" }),
    ];
    const legacySchema3 = [
      `${JSON.stringify({ type: "outage-log", schema: 3 })}\n`,
      ...events.map(eventLine),
      `${JSON.stringify({ type: "projection-mark", gatewayId: "local", at: T0, kind: "down", vaultId: "vault-a" })}\n`,
      `${JSON.stringify({ type: "projection-mark", gatewayId: "remote", at: 0, vaultId: "vault-a" })}\n`,
    ].join("");
    expect(parseOutageLogFile(legacySchema3)).toStrictEqual(events);
    expect(
      formatOutageLogFile(parseOutageLogFile(legacySchema3))
    ).not.toContain("projection-mark");
  });
});

describe(capOutageLog, () => {
  it("keeps everything under the cap, order preserved", () => {
    const events = [event({ at: T0 }), event({ at: T0 + 1 })];
    expect(capOutageLog(events, 500)).toStrictEqual(events);
  });

  it("drops the oldest entries once over the cap, keeping the tail", () => {
    const events = Array.from({ length: 10 }, (_, i) => event({ at: T0 + i }));
    const capped = capOutageLog(events, 3);
    expect(capped).toHaveLength(3);
    expect(capped.map((e) => e.at)).toStrictEqual([T0 + 7, T0 + 8, T0 + 9]);
  });

  it("the shipped cap is 500", () => {
    expect(OUTAGE_LOG_CAP).toBe(500);
  });
});

describe(deriveOutageEvents, () => {
  function state(over: Partial<GatewayRuntimeState> = {}): GatewayRuntimeState {
    return {
      ...initialRuntimeState(
        { id: "local", label: "Local", kind: "local" },
        T0
      ),
      ...over,
    };
  }

  it("logs a down event on an up→down transition, carrying the last error", () => {
    const events = deriveOutageEvents({
      prevStatus: "up",
      prevHealthStatus: undefined,
      state: state({
        status: "down",
        lastCheckAt: T0 + 5000,
        lastError: "fetch failed",
      }),
      componentActions: [],
      now: T0 + 5000,
    });
    expect(events).toStrictEqual([
      {
        at: T0 + 5000,
        kind: "down",
        gatewayId: "local",
        gatewayLabel: "Local",
        detail: "fetch failed",
      },
    ]);
  });

  it("logs nothing when status stays the same", () => {
    const events = deriveOutageEvents({
      prevStatus: "up",
      prevHealthStatus: "ok",
      state: state({
        status: "up",
        healthStatus: "ok",
        lastCheckAt: T0 + 5000,
      }),
      componentActions: [],
      now: T0 + 5000,
    });
    expect(events).toStrictEqual([]);
  });

  it("logs a recovered event on a down→up transition, carrying the outage duration", () => {
    const events = deriveOutageEvents({
      prevStatus: "down",
      prevHealthStatus: undefined,
      state: state({
        status: "up",
        lastCheckAt: T0 + 10_000,
        outages: [
          { startedAt: T0, endedAt: T0 + 10_000, alertedAt: T0 + 8000 },
        ],
      }),
      componentActions: [],
      now: T0 + 10_000,
    });
    expect(events).toStrictEqual([
      {
        at: T0 + 10_000,
        kind: "recovered",
        gatewayId: "local",
        gatewayLabel: "Local",
        durationMs: 10_000,
      },
    ]);
  });

  it("recovered event omits durationMs when the outage row has no endedAt yet", () => {
    const events = deriveOutageEvents({
      prevStatus: "down",
      prevHealthStatus: undefined,
      state: state({
        status: "up",
        lastCheckAt: T0 + 10_000,
        outages: [{ startedAt: T0 }],
      }),
      componentActions: [],
      now: T0 + 10_000,
    });
    expect(events[0]).toStrictEqual({
      at: T0 + 10_000,
      kind: "recovered",
      gatewayId: "local",
      gatewayLabel: "Local",
    });
  });

  it("logs a degraded event when healthStatus first turns degraded, carrying latency", () => {
    const events = deriveOutageEvents({
      prevStatus: "up",
      prevHealthStatus: "ok",
      state: state({
        status: "up",
        healthStatus: "degraded",
        latencyMs: 2500,
        latencyDegraded: true,
        lastCheckAt: T0 + 5000,
      }),
      componentActions: [],
      now: T0 + 5000,
    });
    expect(events).toStrictEqual([
      {
        at: T0 + 5000,
        kind: "degraded",
        gatewayId: "local",
        gatewayLabel: "Local",
        detail: "2500ms latency",
      },
    ]);
  });

  it("blames the unhealthy components, not the latency, when latency is fine", () => {
    const events = deriveOutageEvents({
      prevStatus: "up",
      prevHealthStatus: "ok",
      state: state({
        status: "up",
        healthStatus: "degraded",
        latencyMs: 4,
        latencyDegraded: false,
        componentIssues: [
          { component: "vaults", status: "degraded" },
          { component: "connections", status: "error", message: "ETIMEDOUT" },
        ],
        lastCheckAt: T0 + 5000,
      }),
      componentActions: [],
      now: T0 + 5000,
    });
    expect(events[0]?.detail).toBe("components: vaults, connections");
  });

  it("omits the detail entirely when neither latency nor a component explains it", () => {
    const events = deriveOutageEvents({
      prevStatus: "up",
      prevHealthStatus: "ok",
      state: state({
        status: "up",
        healthStatus: "degraded",
        latencyMs: 4,
        latencyDegraded: false,
        lastCheckAt: T0 + 5000,
      }),
      componentActions: [],
      now: T0 + 5000,
    });
    expect(events[0]).toStrictEqual({
      at: T0 + 5000,
      kind: "degraded",
      gatewayId: "local",
      gatewayLabel: "Local",
    });
  });

  it("does not re-log degraded while it stays degraded across ticks", () => {
    const events = deriveOutageEvents({
      prevStatus: "up",
      prevHealthStatus: "degraded",
      state: state({
        status: "up",
        healthStatus: "degraded",
        latencyMs: 2500,
        lastCheckAt: T0 + 10_000,
      }),
      componentActions: [],
      now: T0 + 10_000,
    });
    expect(events).toStrictEqual([]);
  });

  it("logs one component-error event per de-duped alert action", () => {
    const events = deriveOutageEvents({
      prevStatus: "up",
      prevHealthStatus: "ok",
      state: state({
        status: "up",
        healthStatus: "error",
        lastCheckAt: T0 + 5000,
      }),
      componentActions: [
        { component: "connections", message: "ETIMEDOUT", downForMs: 300_000 },
        { component: "vaults", downForMs: 300_000 },
      ],
      now: T0 + 5000,
    });
    expect(events).toStrictEqual([
      {
        at: T0 + 5000,
        kind: "component-error",
        gatewayId: "local",
        gatewayLabel: "Local",
        detail: "connections: ETIMEDOUT",
        durationMs: 300_000,
      },
      {
        at: T0 + 5000,
        kind: "component-error",
        gatewayId: "local",
        gatewayLabel: "Local",
        detail: "vaults",
        durationMs: 300_000,
      },
    ]);
  });

  it("logs a version-skew event when the skew alert fires", () => {
    const events = deriveOutageEvents({
      prevStatus: "up",
      prevHealthStatus: "ok",
      state: state({ status: "up", lastCheckAt: T0 + 5000 }),
      componentActions: [],
      versionSkewAction: { gatewayVersion: "0.2.0", gatewayProtocolVersion: 2 },
      now: T0 + 5000,
    });
    expect(events).toStrictEqual([
      {
        at: T0 + 5000,
        kind: "version-skew",
        gatewayId: "local",
        gatewayLabel: "Local",
        detail: "v0.2.0 (protocol 2)",
      },
    ]);
  });

  it("can log multiple event kinds in one tick", () => {
    const events = deriveOutageEvents({
      prevStatus: "down",
      prevHealthStatus: "ok",
      state: state({
        status: "up",
        healthStatus: "degraded",
        latencyMs: 2100,
        lastCheckAt: T0 + 5000,
        outages: [{ startedAt: T0, endedAt: T0 + 5000 }],
      }),
      componentActions: [],
      versionSkewAction: { gatewayVersion: "0.2.0", gatewayProtocolVersion: 2 },
      now: T0 + 5000,
    });
    expect(events.map((e) => e.kind)).toStrictEqual([
      "recovered",
      "degraded",
      "version-skew",
    ]);
  });
});
