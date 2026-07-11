/*
 * Pure outage/alert event log formatting + capping + derivation logic
 * (issue #351 wave 4) — mirrors crash-log-core.ts's split: this file is
 * Electron-free so it unit-tests as plain logic; gateway-outage-log.ts
 * wires in `app.getPath('userData')` + real filesystem reads/writes.
 *
 * Where crash-log.ts captures unexpected process crashes, this captures
 * the gateway-monitor's alert-worthy signals durably. Before this module
 * the outage history lived only in `GatewayRuntimeState.outages`
 * (gateway-monitor-core.ts) — in-memory, per-launch — so a restart lost
 * exactly the post-mortem trail you'd want after a bad night (issue #351:
 * "Logs and outage history don't survive restart").
 *
 * `deriveOutageEvents` folds one tick's before/after runtime state (plus
 * the alert actions gateway-monitor.ts already computed that tick) into
 * zero or more durable events:
 *   - `down`/`recovered`/`degraded` fire on every REAL status transition
 *     (mirrors the Overview tab's in-session outage log — not gated by the
 *     OS-alert threshold, since a post-mortem trail wants the whole
 *     picture, not just what crossed the notification bar).
 *   - `component-error`/`version-skew` fire alongside their OS
 *     notification (gateway-monitor.ts's `notifyComponent`/
 *     `notifyVersionSkew`), so the persisted log always agrees with what
 *     actually got surfaced to the user for those two kinds.
 */

import type {
  GatewayComponentAlertAction,
  GatewayRuntimeState,
  GatewayVersionSkewAction,
} from './gateway-monitor-core.js';

export type OutageLogEventKind =
  | 'down'
  | 'degraded'
  | 'component-error'
  | 'version-skew'
  | 'recovered';

export interface OutageLogEvent {
  /** Event time, epoch ms (desktop clock — same clock the monitor's probes use). */
  at: number;
  kind: OutageLogEventKind;
  gatewayId: string;
  gatewayLabel: string;
  /** Component name / error message / version string — kind-dependent. */
  detail?: string;
  /** Downtime length for `recovered`; time-at-error for `component-error`. */
  durationMs?: number;
}

/** Bound on the persisted log — a chatty gateway can't grow this file forever. */
export const OUTAGE_LOG_CAP = 500;

/** One newline-delimited JSON line — NDJSON, cheap to `tail`/parse (same shape as crash.log). */
export function formatOutageLogLine(event: OutageLogEvent): string {
  return `${JSON.stringify(event)}\n`;
}

const KINDS: readonly OutageLogEventKind[] = [
  'down',
  'degraded',
  'component-error',
  'version-skew',
  'recovered',
];

function isOutageLogEvent(value: unknown): value is OutageLogEvent {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.at === 'number' &&
    typeof rec.kind === 'string' &&
    (KINDS as readonly string[]).includes(rec.kind) &&
    typeof rec.gatewayId === 'string' &&
    typeof rec.gatewayLabel === 'string'
  );
}

/**
 * Parse NDJSON content, skipping blank/malformed lines rather than failing
 * the whole read — a torn last line from a crash mid-write shouldn't lose
 * every event that came before it.
 */
export function parseOutageLogLines(raw: string): OutageLogEvent[] {
  const events: OutageLogEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isOutageLogEvent(parsed)) events.push(parsed);
    } catch {
      // Skip a torn/corrupt line — best-effort read, not a hard failure.
    }
  }
  return events;
}

/** Keep the most recent `cap` events, oldest-first order preserved. */
export function capOutageLog(events: OutageLogEvent[], cap: number): OutageLogEvent[] {
  return events.length > cap ? events.slice(events.length - cap) : events;
}

export interface DeriveOutageEventsInput {
  /** The tracked status/healthStatus just BEFORE this tick's probe was folded in. */
  prevStatus: GatewayRuntimeState['status'];
  prevHealthStatus: GatewayRuntimeState['healthStatus'];
  /** The tracked state AFTER `applyProbe` (+ alert evaluation) folded this tick's probe in. */
  state: GatewayRuntimeState;
  /** This tick's de-duped component-error alert actions (`applyComponentAlerts`'s return). */
  componentActions: GatewayComponentAlertAction[];
  /** This tick's de-duped version-skew alert action, if one fired (`applyVersionSkewAlert`'s return). */
  versionSkewAction?: GatewayVersionSkewAction;
  /** Wall clock for events that don't have a probe timestamp to anchor to. */
  now: number;
}

/**
 * Derive this tick's durable alert-log events from the before/after
 * runtime state — pure, so it unit-tests without electron.
 * gateway-monitor.ts calls this once per tick, right after computing the
 * tick's alert actions, and persists the result via
 * gateway-outage-log.ts's `persistOutageEvents`.
 */
export function deriveOutageEvents(input: DeriveOutageEventsInput): OutageLogEvent[] {
  const { prevStatus, prevHealthStatus, state, componentActions, versionSkewAction, now } = input;
  const events: OutageLogEvent[] = [];
  const eventAt = state.lastCheckAt ?? now;
  const base = { gatewayId: state.gatewayId, gatewayLabel: state.gatewayLabel };

  if (prevStatus !== 'down' && state.status === 'down') {
    events.push({
      at: eventAt,
      kind: 'down',
      ...base,
      ...(state.lastError ? { detail: state.lastError } : {}),
    });
  }

  if (prevStatus === 'down' && state.status === 'up') {
    const closed = state.outages[state.outages.length - 1];
    events.push({
      at: eventAt,
      kind: 'recovered',
      ...base,
      ...(closed?.endedAt !== undefined ? { durationMs: closed.endedAt - closed.startedAt } : {}),
    });
  }

  if (prevHealthStatus !== 'degraded' && state.healthStatus === 'degraded') {
    events.push({
      at: eventAt,
      kind: 'degraded',
      ...base,
      ...(state.latencyMs !== undefined ? { detail: `${state.latencyMs}ms latency` } : {}),
    });
  }

  for (const action of componentActions) {
    events.push({
      at: now,
      kind: 'component-error',
      ...base,
      detail: action.message ? `${action.component}: ${action.message}` : action.component,
      durationMs: action.downForMs,
    });
  }

  if (versionSkewAction) {
    events.push({
      at: now,
      kind: 'version-skew',
      ...base,
      detail: `v${versionSkewAction.gatewayVersion} (schema ${versionSkewAction.gatewaySchemaEpoch})`,
    });
  }

  return events;
}
