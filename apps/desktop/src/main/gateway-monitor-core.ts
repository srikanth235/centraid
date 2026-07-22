/*
 * Pure gateway-runtime tracking core, extracted from gateway-monitor.ts so
 * it's unit-testable without pulling in `electron` (the monitor shell needs
 * Notification/BrowserWindow at module load).
 *
 * The model: the main process probes `GET /centraid/_gateway/health` (with
 * an `/info`-only fallback for older gateways) on a fixed cadence and feeds
 * each result through `applyProbe`, which maintains a rolling sample strip,
 * transition-derived outage log, and counters — all in memory, scoped to
 * the app launch and the active gateway (a gateway switch resets tracking).
 * `evaluateAlert` then decides whether the user should be notified: once
 * per outage, after the gateway has been continuously unreachable past the
 * configured threshold, plus a paired "back online" notice when an alerted
 * outage ends.
 *
 * Issue #351 added two more signals on top of plain up/down:
 *   - `healthStatus` reconciles the health probe's aggregate component
 *     status with a sustained-high-latency check ({@link applyProbe}) — a
 *     "listening but hung" gateway now reads as `degraded`, not `up`.
 *   - `applyComponentAlerts` tracks how long each subsystem has sat at
 *     `error` and fires a de-duped OS notification once it crosses
 *     {@link DEFAULT_COMPONENT_ALERT_SECONDS} — mirroring `evaluateAlert`'s
 *     shape but keyed per-component instead of per-gateway.
 *
 * Wave 2 of #351 wires up the version handshake (version-handshake.ts) that
 * previously had zero runtime callers: `applyProbe` judges a REMOTE
 * gateway's **protocol** floor against this build (product version is display
 * only — issue #512) and records the verdict as `versionSkew`. A local
 * gateway is embedded — always built from the same tree as the app — so it's
 * never judged; `versionSkew` stays permanently undefined for it. This is
 * v0's "surface loudly" posture for protocol skew; hard refuse remains the
 * path taken by full `judgeGatewayInfo` / client connect.
 */

import {
  EXPECTED_GATEWAY_VERSION,
  EXPECTED_PROTOCOL_VERSION,
  EXPECTED_SCHEMA_EPOCH,
  GATEWAY_MIN_PROTOCOL_VERSION,
  protocolsCompatible,
} from './version-handshake.js';

/** Result of one heartbeat probe (`/centraid/_gateway/health`, or `/info` on a fallback). */
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
  /**
   * Aggregate status from `/centraid/_gateway/health`'s payload. Undefined
   * when the probe fell back to `/info` (older gateway, pre-#347/#351) —
   * that gateway simply never reports component health.
   */
  healthStatus?: 'ok' | 'degraded' | 'error';
  /** Non-'ok' components from the health snapshot, when `healthStatus` is set. */
  componentIssues?: GatewayComponentIssue[];
}

/** One subsystem sitting at `degraded` or `error` in the health snapshot. */
export interface GatewayComponentIssue {
  component: string;
  status: 'degraded' | 'error';
  message?: string;
}

/**
 * Protocol-handshake verdict for the active (REMOTE only, see file header)
 * gateway. Product `version` strings are informational; `skewed` means the
 * protocol support window failed (issue #512).
 */
export interface GatewayVersionSkew {
  skewed: boolean;
  gatewayVersion: string;
  gatewaySchemaEpoch: number;
  gatewayProtocolVersion: number;
  clientVersion: string;
  clientSchemaEpoch: number;
  clientProtocolVersion: number;
}

/** Action returned by {@link applyVersionSkewAlert} when a skew notification is due. */
export type GatewayVersionSkewAction = {
  gatewayVersion: string;
  gatewaySchemaEpoch: number;
};

/** Per-component alert bookkeeping — mirrors `GatewayOutage`'s de-dupe shape. */
export interface GatewayComponentAlertRecord {
  component: string;
  /** When this component was first seen at 'error' in the current stretch. */
  sinceAt: number;
  /** Set once the OS notification fires — cleared by dropping the record on recovery. */
  alertedAt?: number;
  /** Latest message for this component, carried for the notification body. */
  message?: string;
}

export type GatewayComponentAlertAction = {
  component: string;
  message?: string;
  downForMs: number;
};

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
  /**
   * Reconciled health signal (issue #351): the health probe's aggregate
   * component status, upgraded to `'degraded'` on sustained high latency
   * even when every component reports `ok` (see {@link DEGRADED_LATENCY_MS}).
   * Undefined until the first successful probe reaches `/health`; persists
   * at its last value while the gateway is unreachable or when a probe
   * fell back to `/info` (same "last-known" posture as `version`).
   */
  healthStatus?: 'ok' | 'degraded' | 'error';
  /** Non-'ok' components from the most recent `/health` snapshot. */
  componentIssues?: GatewayComponentIssue[];
  /** True when recent probe latency has sustained above {@link DEGRADED_LATENCY_MS}. */
  latencyDegraded: boolean;
  /** Per-component alert bookkeeping, capped small — internal to the monitor. */
  componentAlerts: GatewayComponentAlertRecord[];
  /**
   * Version-handshake verdict, REMOTE gateways only (see file header) —
   * undefined for a local gateway (always in lockstep) and while no probe
   * carrying `version`/`schemaEpoch` has landed yet. Persists at its last
   * value across a failed probe or an `/info`-fallback probe, same posture
   * as `version`/`schemaEpoch` themselves.
   */
  versionSkew?: GatewayVersionSkew;
  /** De-dupe marker for the skew OS notification — internal, not on the wire snapshot. */
  versionSkewAlertedAt?: number;
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
/**
 * A "listening but hung" gateway (touches no subsystem, just answers HTTP)
 * needs a signal the plain up/down status doesn't carry — sustained probe
 * latency above this folds into `healthStatus: 'degraded'` even when every
 * component reports `ok`.
 */
export const DEGRADED_LATENCY_MS = 2000;
/** Consecutive successful, over-threshold samples before latency counts as "sustained". */
export const SUSTAINED_LATENCY_SAMPLE_COUNT = 3;
/**
 * Component-level alert default (issue #351): longer than the gateway-down
 * threshold ({@link DEFAULT_ALERT_SECONDS}) because a single subsystem
 * erroring is noisier and more often self-healing than the whole gateway
 * being unreachable.
 */
export const DEFAULT_COMPONENT_ALERT_SECONDS = 300;
/** Bound on tracked component-alert records — a runaway health payload can't grow this forever. */
export const COMPONENT_ALERT_CAP = 50;

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
    latencyDegraded: false,
    componentAlerts: [],
  };
}

/** True when the last {@link SUSTAINED_LATENCY_SAMPLE_COUNT} samples are all successful and over the degraded threshold. */
function sustainedHighLatency(samples: GatewaySample[]): boolean {
  if (samples.length < SUSTAINED_LATENCY_SAMPLE_COUNT) return false;
  const tail = samples.slice(-SUSTAINED_LATENCY_SAMPLE_COUNT);
  return tail.every((s) => s.ok && s.latencyMs !== undefined && s.latencyMs > DEGRADED_LATENCY_MS);
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

  const samples = [
    ...state.samples,
    {
      at: probe.at,
      ok: probe.ok,
      ...(probe.latencyMs !== undefined ? { latencyMs: probe.latencyMs } : {}),
    },
  ].slice(-SAMPLE_CAP);
  const latencyDegraded = sustainedHighLatency(samples);

  // healthStatus: 'error' from the probe wins outright; otherwise degraded
  // components OR sustained latency downgrade an 'ok' probe to 'degraded'.
  // A probe that never reached `/health` (fell back to `/info`) carries no
  // opinion — keep the last-known value, same as `version`.
  const healthStatus = probe.ok
    ? probe.healthStatus === 'error'
      ? 'error'
      : probe.healthStatus === 'degraded' || (probe.healthStatus === 'ok' && latencyDegraded)
        ? 'degraded'
        : (probe.healthStatus ?? state.healthStatus)
    : state.healthStatus;

  return {
    ...state,
    status: nextStatus,
    statusSince: transitioned ? probe.at : state.statusSince,
    lastCheckAt: probe.at,
    checksTotal: state.checksTotal + 1,
    checksFailed: state.checksFailed + (probe.ok ? 0 : 1),
    samples,
    outages,
    latencyDegraded,
    ...(healthStatus !== undefined ? { healthStatus } : {}),
    ...(probe.ok && probe.componentIssues !== undefined
      ? { componentIssues: probe.componentIssues }
      : {}),
    // Identity/runtime fields refresh on success and persist across
    // failures (the page still shows the last-known version while down).
    ...(probe.ok
      ? {
          ...(probe.latencyMs !== undefined ? { latencyMs: probe.latencyMs } : {}),
          ...(probe.gatewayStartedAt !== undefined
            ? { gatewayStartedAt: probe.gatewayStartedAt }
            : {}),
          ...(probe.gatewayUptimeMs !== undefined
            ? { gatewayUptimeMs: probe.gatewayUptimeMs }
            : {}),
          ...(probe.version !== undefined ? { version: probe.version } : {}),
          ...(probe.schemaEpoch !== undefined ? { schemaEpoch: probe.schemaEpoch } : {}),
          // Version handshake (wave 2 of #351) — REMOTE gateways only; a
          // local gateway is embedded in this same build and can never
          // skew. `/info`-fallback probes (no version/schemaEpoch) leave
          // the last-known verdict in place, same as `version` above.
          ...(state.gatewayKind === 'remote' &&
          probe.version !== undefined &&
          probe.schemaEpoch !== undefined
            ? {
                versionSkew: {
                  skewed: !protocolsCompatible({
                    localProtocol: EXPECTED_PROTOCOL_VERSION,
                    localMin: GATEWAY_MIN_PROTOCOL_VERSION,
                    peerProtocol: probe.schemaEpoch,
                    peerMin: probe.schemaEpoch,
                  }),
                  gatewayVersion: probe.version,
                  gatewaySchemaEpoch: probe.schemaEpoch,
                  gatewayProtocolVersion: probe.schemaEpoch,
                  clientVersion: EXPECTED_GATEWAY_VERSION,
                  clientSchemaEpoch: EXPECTED_SCHEMA_EPOCH,
                  clientProtocolVersion: EXPECTED_PROTOCOL_VERSION,
                } satisfies GatewayVersionSkew,
              }
            : {}),
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

/**
 * Fold the latest component issues (from `state.componentIssues`) into
 * per-component alert bookkeeping and decide which, if any, have been
 * sitting at `error` long enough to fire a de-duped OS notification.
 * Mirrors `evaluateAlert`'s shape: a component only fires once
 * (`alertedAt` set) and its record is dropped entirely once it recovers
 * (leaves the error set), so a later re-error starts a fresh window and
 * can alert again. `degraded` components are tracked in `componentIssues`
 * for display but don't drive an OS alert — only `error` does.
 */
export function applyComponentAlerts(
  state: GatewayRuntimeState,
  now: number,
  config: GatewayAlertConfig,
): { state: GatewayRuntimeState; actions: GatewayComponentAlertAction[] } {
  const erroring = new Map(
    (state.componentIssues ?? [])
      .filter((c) => c.status === 'error')
      .map((c) => [c.component, c] as const),
  );

  const actions: GatewayComponentAlertAction[] = [];
  const nextRecords: GatewayComponentAlertRecord[] = [];

  for (const rec of state.componentAlerts) {
    const issue = erroring.get(rec.component);
    if (!issue) continue; // recovered — drop the record so a re-error re-arms the alert
    erroring.delete(rec.component);
    let alertedAt = rec.alertedAt;
    if (
      alertedAt === undefined &&
      config.enabled &&
      now - rec.sinceAt >= config.thresholdSeconds * 1000
    ) {
      alertedAt = now;
      actions.push({
        component: rec.component,
        ...(issue.message ? { message: issue.message } : {}),
        downForMs: now - rec.sinceAt,
      });
    }
    nextRecords.push({
      ...rec,
      ...(issue.message ? { message: issue.message } : {}),
      ...(alertedAt !== undefined ? { alertedAt } : {}),
    });
  }
  // Components that started erroring this tick get a fresh record.
  for (const issue of erroring.values()) {
    nextRecords.push({
      component: issue.component,
      sinceAt: now,
      ...(issue.message ? { message: issue.message } : {}),
    });
  }

  return {
    state: { ...state, componentAlerts: nextRecords.slice(-COMPONENT_ALERT_CAP) },
    actions,
  };
}

/**
 * Decide whether the version-skew OS notification is due. Unlike
 * {@link applyComponentAlerts}, there's no "sustained past a threshold"
 * wait: a version/schema mismatch is a static build fact, not a transient
 * blip that might self-heal within a few probes, so it fires as soon as
 * it's observed. It still de-dupes like the component-alert pattern —
 * `versionSkewAlertedAt` marks an already-notified skew so it doesn't refire
 * every 5s tick, and clears the moment the gateway stops reporting skew
 * (e.g. both sides get upgraded to match), re-arming for a later mismatch.
 */
export function applyVersionSkewAlert(
  state: GatewayRuntimeState,
  config: GatewayAlertConfig,
  now: number,
): { state: GatewayRuntimeState; action?: GatewayVersionSkewAction } {
  const skew = state.versionSkew;
  if (!skew?.skewed) {
    if (state.versionSkewAlertedAt === undefined) return { state };
    const { versionSkewAlertedAt: _cleared, ...rest } = state;
    return { state: rest as GatewayRuntimeState };
  }
  if (!config.enabled || state.versionSkewAlertedAt !== undefined) return { state };
  return {
    state: { ...state, versionSkewAlertedAt: now },
    action: { gatewayVersion: skew.gatewayVersion, gatewaySchemaEpoch: skew.gatewaySchemaEpoch },
  };
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
