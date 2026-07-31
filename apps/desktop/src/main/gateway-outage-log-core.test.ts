// governance: allow-repo-hygiene file-size-limit one suite per pure core module (#647): outage derivation, file schema v2, projection marks, and at-most-once replay are one behavioural surface — splitting the suite would split the invariants that only fail together
import { describe, expect, it } from "vitest";

import { initialRuntimeState } from "./gateway-monitor-core.js";
import type { GatewayRuntimeState } from "./gateway-monitor-core.js";
import {
  capOutageLog,
  deriveOutageEvents,
  eventsAfterMark,
  formatOutageLogFile,
  gatewayInboxEvent,
  INBOX_FLUSH_BATCH,
  inboxProjectionTarget,
  OUTAGE_LOG_CAP,
  OUTAGE_LOG_SCHEMA,
  outageEventMark,
  parseOutageLogFile,
  seedProjectionMarks,
} from "./gateway-outage-log-core.js";
import type {
  InboxProjectionMark,
  OutageLogEvent,
  OutageLogFile,
} from "./gateway-outage-log-core.js";

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

function logFile(over: Partial<OutageLogFile> = {}): OutageLogFile {
  return {
    schema: OUTAGE_LOG_SCHEMA,
    events: [],
    projected: {},
    ...over,
  };
}

/** One NDJSON event line, as a build BEFORE projection marks wrote it. */
function legacyLine(e: OutageLogEvent): string {
  return `${JSON.stringify(e)}\n`;
}

describe("formatOutageLogFile / parseOutageLogFile", () => {
  it("round-trips one event through NDJSON", () => {
    const e = event({ detail: "fetch failed" });
    const raw = formatOutageLogFile(logFile({ events: [e] }));
    expect(raw.endsWith("\n")).toBe(true);
    expect(parseOutageLogFile(raw).events).toStrictEqual([e]);
  });

  it("round-trips multiple events in order", () => {
    const events = [
      event({ at: T0, kind: "down" }),
      event({ at: T0 + 1000, kind: "recovered", durationMs: 1000 }),
    ];
    expect(
      parseOutageLogFile(formatOutageLogFile(logFile({ events }))).events
    ).toStrictEqual(events);
  });

  it("round-trips per-gateway projection marks", () => {
    const projected: Record<string, InboxProjectionMark> = {
      local: { at: T0, kind: "down", detail: "fetch failed" },
      remote: { at: T0 + 5, kind: "recovered" },
    };
    const parsed = parseOutageLogFile(
      formatOutageLogFile(logFile({ events: [event()], projected }))
    );
    expect(parsed.projected).toStrictEqual(projected);
    expect(parsed.schema).toBe(OUTAGE_LOG_SCHEMA);
    // A mark line must never be mistaken for an event.
    expect(parsed.events).toStrictEqual([event()]);
  });

  it("skips blank lines", () => {
    const raw = `${legacyLine(event())}\n\n${legacyLine(event({ at: T0 + 1 }))}`;
    expect(parseOutageLogFile(raw).events).toHaveLength(2);
  });

  it("skips a torn/corrupt line without losing the rest", () => {
    const good = legacyLine(event());
    const raw = `${good}{"at": broken json\n${legacyLine(event({ at: T0 + 1 }))}`;
    expect(parseOutageLogFile(raw).events).toHaveLength(2);
  });

  it("skips a well-formed JSON value missing required fields", () => {
    const raw = `${JSON.stringify({ at: T0, kind: "down" })}\n${legacyLine(event({ at: T0 + 1 }))}`;
    expect(parseOutageLogFile(raw).events).toHaveLength(1);
  });

  it("skips an event with an unrecognized kind", () => {
    const raw = `${JSON.stringify({ ...event(), kind: "bogus" })}\n${legacyLine(event({ at: T0 + 1 }))}`;
    expect(parseOutageLogFile(raw).events).toHaveLength(1);
  });

  it("empty input parses to an empty legacy-schema log", () => {
    expect(parseOutageLogFile("")).toStrictEqual({
      schema: 1,
      events: [],
      projected: {},
    });
  });

  it("a log with no header line reads as the pre-mark schema", () => {
    const raw = [legacyLine(event()), legacyLine(event({ at: T0 + 1 }))].join(
      ""
    );
    expect(parseOutageLogFile(raw).schema).toBe(1);
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

describe(gatewayInboxEvent, () => {
  it("keeps down and recovery as distinct Inbox cards", () => {
    const down = gatewayInboxEvent(
      event({ kind: "down", at: T0, detail: "connection refused" })
    );
    const recovered = gatewayInboxEvent(
      event({ kind: "recovered", at: T0 + 60_000, durationMs: 60_000 })
    );

    expect(down).toMatchObject({
      sourceRef: "gateway-health:local:gateway:down",
      headline: "Local is unreachable",
      severity: "high",
      detail: { outcome: "down" },
    });
    expect(recovered).toMatchObject({
      sourceRef: "gateway-health:local:gateway:recovered",
      headline: "Local recovered",
      severity: "info",
      detail: { outcome: "recovered", durationMs: 60_000 },
    });
    expect(down.sourceRef).not.toBe(recovered.sourceRef);
  });

  it("a flap of five down/recovered cycles collapses onto two source refs", () => {
    const flap: OutageLogEvent[] = [];
    for (let cycle = 0; cycle < 5; cycle += 1) {
      flap.push(
        event({
          kind: "down",
          at: T0 + cycle * 60_000,
          detail: "ECONNREFUSED",
        }),
        event({
          kind: "recovered",
          at: T0 + cycle * 60_000 + 30_000,
          durationMs: 30_000,
        })
      );
    }
    const refs = flap.map((e) => gatewayInboxEvent(e).sourceRef);

    expect(new Set(refs)).toStrictEqual(
      new Set([
        "gateway-health:local:gateway:down",
        "gateway-health:local:gateway:recovered",
      ])
    );
  });

  it("carries each occurrence's own timestamp in the detail payload", () => {
    const first = gatewayInboxEvent(event({ kind: "down", at: T0 }));
    const second = gatewayInboxEvent(event({ kind: "down", at: T0 + 60_000 }));

    expect(first.sourceRef).toBe(second.sourceRef);
    expect(first.detail.occurredAt).toBe(new Date(T0).toISOString());
    expect(second.detail.occurredAt).toBe(new Date(T0 + 60_000).toISOString());
    expect(second.at).toBe(new Date(T0 + 60_000).toISOString());
  });

  it("scopes a component error to its component, not to the error message", () => {
    const timeout = gatewayInboxEvent(
      event({ kind: "component-error", detail: "connections: ETIMEDOUT" })
    );
    const reset = gatewayInboxEvent(
      event({
        kind: "component-error",
        at: T0 + 1000,
        detail: "connections: ECONNRESET",
      })
    );
    const otherComponent = gatewayInboxEvent(
      event({ kind: "component-error", at: T0 + 2000, detail: "vaults" })
    );

    expect(timeout.sourceRef).toBe(
      "gateway-health:local:connections:component-error"
    );
    // Same component, different message — one card, not two.
    expect(reset.sourceRef).toBe(timeout.sourceRef);
    // A different component keeps its own card.
    expect(otherComponent.sourceRef).toBe(
      "gateway-health:local:vaults:component-error"
    );
  });

  it("keeps two gateways' cards apart", () => {
    expect(
      gatewayInboxEvent(event({ gatewayId: "remote" })).sourceRef
    ).not.toBe(gatewayInboxEvent(event({ gatewayId: "local" })).sourceRef);
  });
});

describe(eventsAfterMark, () => {
  it("with no mark, everything is unprojected", () => {
    const events = [event({ at: T0 }), event({ at: T0 + 1 })];
    expect(eventsAfterMark(events, undefined)).toStrictEqual(events);
  });

  it("returns only what follows the marked event", () => {
    const events = [
      event({ at: T0, kind: "down" }),
      event({ at: T0 + 1, kind: "recovered" }),
      event({ at: T0 + 2, kind: "down" }),
    ];
    expect(
      eventsAfterMark(events, outageEventMark(events[1] as OutageLogEvent))
    ).toStrictEqual([events[2]]);
  });

  it("returns nothing when the mark is the newest event", () => {
    const events = [event({ at: T0 }), event({ at: T0 + 1 })];
    expect(
      eventsAfterMark(events, outageEventMark(events[1] as OutageLogEvent))
    ).toStrictEqual([]);
  });

  it("distinguishes two events recorded in the same millisecond", () => {
    const events = [
      event({ at: T0, kind: "recovered" }),
      event({ at: T0, kind: "degraded", detail: "2500ms latency" }),
    ];
    expect(
      eventsAfterMark(events, outageEventMark(events[0] as OutageLogEvent))
    ).toStrictEqual([events[1]]);
  });

  it("falls back to the timestamp once the marked event has rolled off the cap", () => {
    const rolledOff = event({ at: T0, kind: "down", detail: "gone" });
    const events = [event({ at: T0 + 1 }), event({ at: T0 + 2 })];
    expect(eventsAfterMark(events, outageEventMark(rolledOff))).toStrictEqual(
      events
    );
  });
});

describe(seedProjectionMarks, () => {
  it("adopts a pre-mark log wholesale so an upgrade flushes nothing", () => {
    const legacy = parseOutageLogFile(
      [
        legacyLine(event({ at: T0, kind: "down" })),
        legacyLine(event({ at: T0 + 1, kind: "recovered" })),
        legacyLine(event({ at: T0 + 2, gatewayId: "remote" })),
      ].join("")
    );
    expect(legacy.schema).toBe(1);

    const seeded = seedProjectionMarks(legacy);

    expect(seeded.schema).toBe(OUTAGE_LOG_SCHEMA);
    // Every gateway's mark sits at the END of its own history…
    expect(seeded.projected.local).toStrictEqual({
      at: T0 + 1,
      kind: "recovered",
    });
    expect(seeded.projected.remote).toStrictEqual({ at: T0 + 2, kind: "down" });
    // …so nothing at all is pending for either gateway: no storm.
    for (const gatewayId of ["local", "remote"]) {
      expect(
        eventsAfterMark(
          seeded.events.filter((e) => e.gatewayId === gatewayId),
          seeded.projected[gatewayId]
        )
      ).toStrictEqual([]);
    }
    // The events themselves are untouched — the Alerts tab still shows them.
    expect(seeded.events).toStrictEqual(legacy.events);
  });

  it("leaves a mark-aware log alone, so an unflushed backlog still projects", () => {
    // A gateway that went down while unreachable and never got flushed before
    // the desktop restarted: schema 2, no mark. That backlog is REAL.
    const file = logFile({ events: [event({ at: T0, kind: "down" })] });
    expect(seedProjectionMarks(file)).toBe(file);
    expect(eventsAfterMark(file.events, file.projected.local)).toStrictEqual(
      file.events
    );
  });
});

describe("Inbox projection is at-most-once across restarts and vault switches", () => {
  /**
   * Replays the monitor's project-then-advance loop against a durable log.
   * `vaultId` only decides WHERE a batch lands — never whether it is resent —
   * which is the cross-vault duplication the mark exists to prevent.
   */
  function project(
    file: OutageLogFile,
    gatewayId: string,
    vaultId: string
  ): { file: OutageLogFile; sent: { vaultId: string; refs: string[] } } {
    const pending = eventsAfterMark(
      file.events.filter((e) => e.gatewayId === gatewayId),
      file.projected[gatewayId]
    ).slice(0, INBOX_FLUSH_BATCH);
    const last = pending[pending.length - 1];
    return {
      file: last
        ? {
            ...file,
            projected: {
              ...file.projected,
              [gatewayId]: outageEventMark(last),
            },
          }
        : file,
      sent: {
        vaultId,
        refs: pending.map((e) => gatewayInboxEvent(e).sourceRef),
      },
    };
  }

  /** A restart: the in-memory state is thrown away, the FILE is not. */
  function restart(file: OutageLogFile): OutageLogFile {
    return parseOutageLogFile(formatOutageLogFile(file));
  }

  it("never resends an event, even when the active vault changes", () => {
    let file = logFile({
      events: [
        event({ at: T0, kind: "down" }),
        event({ at: T0 + 1000, kind: "recovered", durationMs: 1000 }),
      ],
    });
    const sends: { vaultId: string; refs: string[] }[] = [];

    const first = project(file, "local", "vault-a");
    file = first.file;
    sends.push(first.sent);

    // Restart with a DIFFERENT vault active — the old per-launch replay set
    // projected the whole history again into that vault.
    file = restart(file);
    const second = project(file, "local", "vault-b");
    file = second.file;
    sends.push(second.sent);

    // A third launch, back on the original vault.
    file = restart(file);
    const third = project(file, "local", "vault-a");
    sends.push(third.sent);

    expect(sends[0]?.refs).toStrictEqual([
      "gateway-health:local:gateway:down",
      "gateway-health:local:gateway:recovered",
    ]);
    expect(sends[1]?.refs).toStrictEqual([]);
    expect(sends[2]?.refs).toStrictEqual([]);
  });

  it("a failed POST leaves the mark alone, so the batch retries verbatim", () => {
    const file = logFile({ events: [event({ at: T0, kind: "down" })] });
    // The monitor only advances inside `.then()`; a rejected POST skips it.
    const pending = eventsAfterMark(file.events, file.projected.local);
    expect(pending).toHaveLength(1);
    // Mark untouched → same pending set next tick.
    expect(eventsAfterMark(file.events, file.projected.local)).toStrictEqual(
      pending
    );
  });

  it("drains a backlog larger than the server's batch cap oldest-first", () => {
    let file = logFile({
      events: Array.from({ length: INBOX_FLUSH_BATCH + 30 }, (_, i) =>
        event({ at: T0 + i, kind: i % 2 === 0 ? "down" : "recovered" })
      ),
    });
    const batches: number[] = [];
    for (let tick = 0; tick < 3; tick += 1) {
      const pending = eventsAfterMark(file.events, file.projected.local).slice(
        0,
        INBOX_FLUSH_BATCH
      );
      batches.push(pending.length);
      const last = pending[pending.length - 1];
      if (last)
        file = {
          ...file,
          projected: { ...file.projected, local: outageEventMark(last) },
        };
    }
    // Nothing is truncated away: the whole backlog lands across ticks.
    expect(batches).toStrictEqual([INBOX_FLUSH_BATCH, 30, 0]);
  });
});

describe(inboxProjectionTarget, () => {
  const base = {
    probeOk: true,
    gatewayUrl: "http://127.0.0.1:4310",
    vaultId: "vault-a",
    pendingCount: 1,
  };

  it("resolves the target when the gateway is reachable and a vault is active", () => {
    expect(inboxProjectionTarget(base)).toStrictEqual({
      gatewayUrl: "http://127.0.0.1:4310",
      vaultId: "vault-a",
    });
  });

  it("treats an empty-string active vault as unset", () => {
    expect(inboxProjectionTarget({ ...base, vaultId: "" })).toBeUndefined();
  });

  it("skips when no vault is set at all", () => {
    expect(
      inboxProjectionTarget({ ...base, vaultId: undefined })
    ).toBeUndefined();
  });

  it("skips when the gateway URL has not resolved yet", () => {
    expect(
      inboxProjectionTarget({ ...base, gatewayUrl: undefined })
    ).toBeUndefined();
    expect(inboxProjectionTarget({ ...base, gatewayUrl: "" })).toBeUndefined();
  });

  it("skips while the gateway is unreachable, and when there is nothing to send", () => {
    expect(inboxProjectionTarget({ ...base, probeOk: false })).toBeUndefined();
    expect(inboxProjectionTarget({ ...base, pendingCount: 0 })).toBeUndefined();
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
      versionSkewAction: { gatewayVersion: "0.2.0", gatewaySchemaEpoch: 2 },
      now: T0 + 5000,
    });
    expect(events).toStrictEqual([
      {
        at: T0 + 5000,
        kind: "version-skew",
        gatewayId: "local",
        gatewayLabel: "Local",
        detail: "v0.2.0 (schema 2)",
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
      versionSkewAction: { gatewayVersion: "0.2.0", gatewaySchemaEpoch: 2 },
      now: T0 + 5000,
    });
    expect(events.map((e) => e.kind)).toStrictEqual([
      "recovered",
      "degraded",
      "version-skew",
    ]);
  });
});
