/*
 * Pure gateway-runtime tracking core, extracted from gateway-monitor.ts so
 * it's unit-testable without pulling in `electron` (the monitor shell needs
 * Notification/BrowserWindow at module load).
 *
 * The model: the main process probes `GET /centraid/_gateway/info` on a
 * fixed cadence and feeds each result through `applyProbe`, which maintains
 * a rolling sample strip, transition-derived outage log, and counters —
 * all in memory, scoped to the app launch and the active gateway (a gateway
 * switch resets tracking). `evaluateAlert` then decides whether the user
 * should be notified: once per outage, after the gateway has been
 * continuously unreachable past the configured threshold, plus a paired
 * "back online" notice when an alerted outage ends.
 */

/** Result of one `/centraid/_gateway/info` probe. */
export interface GatewayProbe {
  /** Probe completion time (epoch ms, desktop clock). */
  at: number;
  ok: boolean;
  latencyMs?: number;
  /** Server-reported process start (epoch ms, gateway clock). */
  gatewayStartedAt?: number;
  /** Server-reported uptime — clock-skew-safe companion to `gatewayStartedAt`. */
  gatewayUptimeMs?: number;
  version?: string;
  schemaEpoch?: number;
  /** Failure reason when `!ok` (fetch error / HTTP status). */
  detail?: string;
}

export interface GatewaySample {
  at: number;
  ok: boolean;
  latencyMs?: number;
}

/** One continuous stretch of failed probes. Open-ended while ongoing. */
export interface GatewayOutage {
  startedAt: number;
  endedAt?: number;
  /** Set when the down alert fired for this outage (once, ever). */
  alertedAt?: number;
  /** Set when the paired "back online" notice fired. */
  recoveredNoticeAt?: number;
}

export interface GatewayRuntimeState {
  /** Which gateway this history belongs to — a switch resets tracking. */
  gatewayId: string;
  gatewayLabel: string;
  gatewayKind: 'local' | 'remote';
  /** When this state was created (app launch or gateway switch). */
  trackingSince: number;
  status: 'unknown' | 'up' | 'down';
  /** When the current status began (first probe that established it). */
  statusSince?: number;
  lastCheckAt?: number;
  latencyMs?: number;
  gatewayStartedAt?: number;
  gatewayUptimeMs?: number;
  version?: string;
  schemaEpoch?: number;
  /** Failure detail from the most recent failed probe. */
  lastError?: string;
  checksTotal: number;
  checksFailed: number;
  /** Rolling probe strip, oldest first, capped at {@link SAMPLE_CAP}. */
  samples: GatewaySample[];
  /** Outage log, oldest first, capped at {@link OUTAGE_CAP}. */
  outages: GatewayOutage[];
}

export interface GatewayAlertConfig {
  enabled: boolean;
  thresholdSeconds: number;
}

export type GatewayAlertAction =
  | { kind: 'down'; downForMs: number }
  | { kind: 'recovered'; outageMs: number };

/** Sane default: alert after the gateway has been down for 2 minutes. */
export const DEFAULT_ALERT_SECONDS = 120;
export const MIN_ALERT_SECONDS = 15;
export const MAX_ALERT_SECONDS = 3600;
/** 240 probes at the 5s cadence ≈ the last 20 minutes. */
export const SAMPLE_CAP = 240;
export const OUTAGE_CAP = 50;

/** Clamp a raw settings value into the valid alert-threshold range.
 *  Returns `undefined` for non-numeric garbage (field is then dropped). */
export function clampAlertSeconds(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.min(MAX_ALERT_SECONDS, Math.max(MIN_ALERT_SECONDS, Math.round(raw)));
}

export function initialRuntimeState(
  gateway: { id: string; label: string; kind: 'local' | 'remote' },
  now: number,
): GatewayRuntimeState {
  return {
    gatewayId: gateway.id,
    gatewayLabel: gateway.label,
    gatewayKind: gateway.kind,
    trackingSince: now,
    status: 'unknown',
    checksTotal: 0,
    checksFailed: 0,
    samples: [],
    outages: [],
  };
}

/** Fold one probe result into the runtime state. Pure — returns a new state. */
export function applyProbe(state: GatewayRuntimeState, probe: GatewayProbe): GatewayRuntimeState {
  const nextStatus = probe.ok ? 'up' : 'down';
  const transitioned = state.status !== nextStatus;

  let outages = state.outages;
  if (probe.ok && transitioned && state.status === 'down') {
    // Close the open outage. (An open outage always exists after a down
    // transition; slice defensively anyway.)
    const last = outages[outages.length - 1];
    if (last && last.endedAt === undefined) {
      outages = [...outages.slice(0, -1), { ...last, endedAt: probe.at }];
    }
  } else if (!probe.ok && transitioned) {
    // 'up' → 'down', or the very first probe failing ('unknown' → 'down').
    outages = [...outages, { startedAt: probe.at }].slice(-OUTAGE_CAP);
  }

  return {
    ...state,
    status: nextStatus,
    statusSince: transitioned ? probe.at : state.statusSince,
    lastCheckAt: probe.at,
    checksTotal: state.checksTotal + 1,
    checksFailed: state.checksFailed + (probe.ok ? 0 : 1),
    samples: [
      ...state.samples,
      { at: probe.at, ok: probe.ok, ...(probe.latencyMs !== undefined ? { latencyMs: probe.latencyMs } : {}) },
    ].slice(-SAMPLE_CAP),
    outages,
    // Identity/runtime fields refresh on success and persist across
    // failures (the page still shows the last-known version while down).
    ...(probe.ok
      ? {
          ...(probe.latencyMs !== undefined ? { latencyMs: probe.latencyMs } : {}),
          ...(probe.gatewayStartedAt !== undefined ? { gatewayStartedAt: probe.gatewayStartedAt } : {}),
          ...(probe.gatewayUptimeMs !== undefined ? { gatewayUptimeMs: probe.gatewayUptimeMs } : {}),
          ...(probe.version !== undefined ? { version: probe.version } : {}),
          ...(probe.schemaEpoch !== undefined ? { schemaEpoch: probe.schemaEpoch } : {}),
        }
      : probe.detail !== undefined
        ? { lastError: probe.detail }
        : {}),
  };
}

/**
 * Decide whether a notification is due, marking the outage so it never
 * re-fires. The down alert requires alerts to be enabled at evaluation
 * time; the recovery notice pairs with an already-fired down alert and is
 * delivered even if the user toggled alerts off mid-outage.
 */
export function evaluateAlert(
  state: GatewayRuntimeState,
  config: GatewayAlertConfig,
  now: number,
): { state: GatewayRuntimeState; action?: GatewayAlertAction } {
  const last = state.outages[state.outages.length - 1];
  if (!last) return { state };

  if (state.status === 'down' && last.endedAt === undefined) {
    if (!config.enabled || last.alertedAt !== undefined) return { state };
    const downForMs = now - last.startedAt;
    if (downForMs < config.thresholdSeconds * 1000) return { state };
    return {
      state: {
        ...state,
        outages: [...state.outages.slice(0, -1), { ...last, alertedAt: now }],
      },
      action: { kind: 'down', downForMs },
    };
  }

  if (
    state.status === 'up' &&
    last.endedAt !== undefined &&
    last.alertedAt !== undefined &&
    last.recoveredNoticeAt === undefined
  ) {
    return {
      state: {
        ...state,
        outages: [...state.outages.slice(0, -1), { ...last, recoveredNoticeAt: now }],
      },
      action: { kind: 'recovered', outageMs: last.endedAt - last.startedAt },
    };
  }

  return { state };
}

/** Compact human duration — `47s`, `3m 20s`, `2h 05m`, `1d 4h`. */
export function formatDurationMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
