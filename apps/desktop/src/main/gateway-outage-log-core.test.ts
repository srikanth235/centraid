import { describe, expect, it } from 'vitest';
import {
  capOutageLog,
  deriveOutageEvents,
  formatOutageLogLine,
  OUTAGE_LOG_CAP,
  parseOutageLogLines,
  type OutageLogEvent,
} from './gateway-outage-log-core.js';
import { initialRuntimeState, type GatewayRuntimeState } from './gateway-monitor-core.js';

const T0 = Date.UTC(2026, 6, 11, 12, 0, 0);

function event(over: Partial<OutageLogEvent> = {}): OutageLogEvent {
  return {
    at: T0,
    kind: 'down',
    gatewayId: 'local',
    gatewayLabel: 'Local',
    ...over,
  };
}

describe('formatOutageLogLine / parseOutageLogLines', () => {
  it('round-trips one event through NDJSON', () => {
    const e = event({ detail: 'fetch failed' });
    const line = formatOutageLogLine(e);
    expect(line.endsWith('\n')).toBe(true);
    expect(parseOutageLogLines(line)).toEqual([e]);
  });

  it('round-trips multiple events in order', () => {
    const events = [
      event({ at: T0, kind: 'down' }),
      event({ at: T0 + 1000, kind: 'recovered', durationMs: 1000 }),
    ];
    const raw = events.map(formatOutageLogLine).join('');
    expect(parseOutageLogLines(raw)).toEqual(events);
  });

  it('skips blank lines', () => {
    const raw = `${formatOutageLogLine(event())}\n\n${formatOutageLogLine(event({ at: T0 + 1 }))}`;
    expect(parseOutageLogLines(raw)).toHaveLength(2);
  });

  it('skips a torn/corrupt line without losing the rest', () => {
    const good = formatOutageLogLine(event());
    const raw = `${good}{"at": broken json\n${formatOutageLogLine(event({ at: T0 + 1 }))}`;
    expect(parseOutageLogLines(raw)).toHaveLength(2);
  });

  it('skips a well-formed JSON value missing required fields', () => {
    const raw = `${JSON.stringify({ at: T0, kind: 'down' })}\n${formatOutageLogLine(event({ at: T0 + 1 }))}`;
    expect(parseOutageLogLines(raw)).toHaveLength(1);
  });

  it('skips an event with an unrecognized kind', () => {
    const raw = `${JSON.stringify({ ...event(), kind: 'bogus' })}\n${formatOutageLogLine(event({ at: T0 + 1 }))}`;
    expect(parseOutageLogLines(raw)).toHaveLength(1);
  });

  it('empty input parses to an empty list', () => {
    expect(parseOutageLogLines('')).toEqual([]);
  });
});

describe('capOutageLog', () => {
  it('keeps everything under the cap, order preserved', () => {
    const events = [event({ at: T0 }), event({ at: T0 + 1 })];
    expect(capOutageLog(events, 500)).toEqual(events);
  });

  it('drops the oldest entries once over the cap, keeping the tail', () => {
    const events = Array.from({ length: 10 }, (_, i) => event({ at: T0 + i }));
    const capped = capOutageLog(events, 3);
    expect(capped).toHaveLength(3);
    expect(capped.map((e) => e.at)).toEqual([T0 + 7, T0 + 8, T0 + 9]);
  });

  it('the shipped cap is 500', () => {
    expect(OUTAGE_LOG_CAP).toBe(500);
  });
});

describe('deriveOutageEvents', () => {
  function state(over: Partial<GatewayRuntimeState> = {}): GatewayRuntimeState {
    return {
      ...initialRuntimeState({ id: 'local', label: 'Local', kind: 'local' }, T0),
      ...over,
    };
  }

  it('logs a down event on an up→down transition, carrying the last error', () => {
    const events = deriveOutageEvents({
      prevStatus: 'up',
      prevHealthStatus: undefined,
      state: state({ status: 'down', lastCheckAt: T0 + 5000, lastError: 'fetch failed' }),
      componentActions: [],
      now: T0 + 5000,
    });
    expect(events).toEqual([
      {
        at: T0 + 5000,
        kind: 'down',
        gatewayId: 'local',
        gatewayLabel: 'Local',
        detail: 'fetch failed',
      },
    ]);
  });

  it('logs nothing when status stays the same', () => {
    const events = deriveOutageEvents({
      prevStatus: 'up',
      prevHealthStatus: 'ok',
      state: state({ status: 'up', healthStatus: 'ok', lastCheckAt: T0 + 5000 }),
      componentActions: [],
      now: T0 + 5000,
    });
    expect(events).toEqual([]);
  });

  it('logs a recovered event on a down→up transition, carrying the outage duration', () => {
    const events = deriveOutageEvents({
      prevStatus: 'down',
      prevHealthStatus: undefined,
      state: state({
        status: 'up',
        lastCheckAt: T0 + 10_000,
        outages: [{ startedAt: T0, endedAt: T0 + 10_000, alertedAt: T0 + 8000 }],
      }),
      componentActions: [],
      now: T0 + 10_000,
    });
    expect(events).toEqual([
      {
        at: T0 + 10_000,
        kind: 'recovered',
        gatewayId: 'local',
        gatewayLabel: 'Local',
        durationMs: 10_000,
      },
    ]);
  });

  it('recovered event omits durationMs when the outage row has no endedAt yet', () => {
    const events = deriveOutageEvents({
      prevStatus: 'down',
      prevHealthStatus: undefined,
      state: state({ status: 'up', lastCheckAt: T0 + 10_000, outages: [{ startedAt: T0 }] }),
      componentActions: [],
      now: T0 + 10_000,
    });
    expect(events[0]).toEqual({
      at: T0 + 10_000,
      kind: 'recovered',
      gatewayId: 'local',
      gatewayLabel: 'Local',
    });
  });

  it('logs a degraded event when healthStatus first turns degraded, carrying latency', () => {
    const events = deriveOutageEvents({
      prevStatus: 'up',
      prevHealthStatus: 'ok',
      state: state({
        status: 'up',
        healthStatus: 'degraded',
        latencyMs: 2500,
        lastCheckAt: T0 + 5000,
      }),
      componentActions: [],
      now: T0 + 5000,
    });
    expect(events).toEqual([
      {
        at: T0 + 5000,
        kind: 'degraded',
        gatewayId: 'local',
        gatewayLabel: 'Local',
        detail: '2500ms latency',
      },
    ]);
  });

  it('does not re-log degraded while it stays degraded across ticks', () => {
    const events = deriveOutageEvents({
      prevStatus: 'up',
      prevHealthStatus: 'degraded',
      state: state({
        status: 'up',
        healthStatus: 'degraded',
        latencyMs: 2500,
        lastCheckAt: T0 + 10_000,
      }),
      componentActions: [],
      now: T0 + 10_000,
    });
    expect(events).toEqual([]);
  });

  it('logs one component-error event per de-duped alert action', () => {
    const events = deriveOutageEvents({
      prevStatus: 'up',
      prevHealthStatus: 'ok',
      state: state({ status: 'up', healthStatus: 'error', lastCheckAt: T0 + 5000 }),
      componentActions: [
        { component: 'connections', message: 'ETIMEDOUT', downForMs: 300_000 },
        { component: 'vaults', downForMs: 300_000 },
      ],
      now: T0 + 5000,
    });
    expect(events).toEqual([
      {
        at: T0 + 5000,
        kind: 'component-error',
        gatewayId: 'local',
        gatewayLabel: 'Local',
        detail: 'connections: ETIMEDOUT',
        durationMs: 300_000,
      },
      {
        at: T0 + 5000,
        kind: 'component-error',
        gatewayId: 'local',
        gatewayLabel: 'Local',
        detail: 'vaults',
        durationMs: 300_000,
      },
    ]);
  });

  it('logs a version-skew event when the skew alert fires', () => {
    const events = deriveOutageEvents({
      prevStatus: 'up',
      prevHealthStatus: 'ok',
      state: state({ status: 'up', lastCheckAt: T0 + 5000 }),
      componentActions: [],
      versionSkewAction: { gatewayVersion: '0.2.0', gatewaySchemaEpoch: 2 },
      now: T0 + 5000,
    });
    expect(events).toEqual([
      {
        at: T0 + 5000,
        kind: 'version-skew',
        gatewayId: 'local',
        gatewayLabel: 'Local',
        detail: 'v0.2.0 (schema 2)',
      },
    ]);
  });

  it('can log multiple event kinds in one tick', () => {
    const events = deriveOutageEvents({
      prevStatus: 'down',
      prevHealthStatus: 'ok',
      state: state({
        status: 'up',
        healthStatus: 'degraded',
        latencyMs: 2100,
        lastCheckAt: T0 + 5000,
        outages: [{ startedAt: T0, endedAt: T0 + 5000 }],
      }),
      componentActions: [],
      versionSkewAction: { gatewayVersion: '0.2.0', gatewaySchemaEpoch: 2 },
      now: T0 + 5000,
    });
    expect(events.map((e) => e.kind)).toEqual(['recovered', 'degraded', 'version-skew']);
  });
});
