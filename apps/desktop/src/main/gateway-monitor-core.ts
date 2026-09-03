/*
 * Pure gateway-runtime tracking; must stay free of `electron` imports to remain
 * unit-testable. State is in-memory, scoped to this launch and the active
 * gateway. Skew is judged on the protocol floor, not product version (#512),
 * and only for REMOTE gateways — a local one ships from this same tree. Hard
 * refuse stays with `judgeGatewayInfo`; here skew only surfaces loudly.
 */
import {
  EXPECTED_GATEWAY_VERSION,
  EXPECTED_PROTOCOL_VERSION,
  GATEWAY_MIN_PROTOCOL_VERSION,
  protocolsCompatible,
} from "./version-handshake.js";

export interface GatewayProbe {
  at: number;
  ok: boolean;
  latencyMs?: number;
  gatewayStartedAt?: number;
  gatewayUptimeMs?: number;
  version?: string;
  protocolVersion?: number;
  detail?: string;
  /**
   * A SYNTHESIZED failure: no request was made because the desktop has no URL
   * yet. "Not started yet", not "unreachable" — see {@link isPendingBootProbe}.
   * A crash-looped local gateway is deliberately NOT flagged; that is real.
   */
  bootPhase?: boolean;
  healthStatus?: "ok" | "degraded" | "error";
  componentIssues?: GatewayComponentIssue[];
}

export interface GatewayComponentIssue {
  component: string;
  status: "degraded" | "error";
  message?: string;
}

/** `skewed` means the protocol support window failed (#512). */
export interface GatewayVersionSkew {
  skewed: boolean;
  gatewayVersion: string;
  gatewayProtocolVersion: number;
  clientVersion: string;
  clientProtocolVersion: number;
}

export type GatewayVersionSkewAction = {
  gatewayVersion: string;
  gatewayProtocolVersion: number;
};

export interface GatewayComponentAlertRecord {
  component: string;
  sinceAt: number;
  alertedAt?: number;
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

export interface GatewayOutage {
  startedAt: number;
  endedAt?: number;
  alertedAt?: number;
  recoveredNoticeAt?: number;
}

export interface GatewayRuntimeState {
  gatewayId: string;
  gatewayLabel: string;
  gatewayKind: "local" | "remote";
  trackingSince: number;
  status: "unknown" | "up" | "down";
  statusSince?: number;
  lastCheckAt?: number;
  latencyMs?: number;
  gatewayStartedAt?: number;
  gatewayUptimeMs?: number;
  version?: string;
  protocolVersion?: number;
  lastError?: string;
  checksTotal: number;
  checksFailed: number;
  samples: GatewaySample[];
  outages: GatewayOutage[];
  healthStatus?: "ok" | "degraded" | "error";
  componentIssues?: GatewayComponentIssue[];
  latencyDegraded: boolean;
  componentAlerts: GatewayComponentAlertRecord[];
  versionSkew?: GatewayVersionSkew;
  versionSkewAlertedAt?: number;
}

export interface GatewayAlertConfig {
  enabled: boolean;
  thresholdSeconds: number;
}

export type GatewayAlertAction =
  | { kind: "down"; downForMs: number }
  | { kind: "recovered"; outageMs: number };

export const DEFAULT_ALERT_SECONDS = 120;
export const MIN_ALERT_SECONDS = 15;
export const MAX_ALERT_SECONDS = 3600;
export const SAMPLE_CAP = 240;
export const OUTAGE_CAP = 50;
export const DEGRADED_LATENCY_MS = 2000;
export const SUSTAINED_LATENCY_SAMPLE_COUNT = 3;
export const DEFAULT_COMPONENT_ALERT_SECONDS = 300;
export const COMPONENT_ALERT_CAP = 50;

export function clampAlertSeconds(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.min(
    MAX_ALERT_SECONDS,
    Math.max(MIN_ALERT_SECONDS, Math.round(raw))
  );
}

export function initialRuntimeState(
  gateway: { id: string; label: string; kind: "local" | "remote" },
  now: number
): GatewayRuntimeState {
  return {
    gatewayId: gateway.id,
    gatewayLabel: gateway.label,
    gatewayKind: gateway.kind,
    trackingSince: now,
    status: "unknown",
    checksTotal: 0,
    checksFailed: 0,
    samples: [],
    outages: [],
    latencyDegraded: false,
    componentAlerts: [],
  };
}

function sustainedHighLatency(samples: GatewaySample[]): boolean {
  if (samples.length < SUSTAINED_LATENCY_SAMPLE_COUNT) return false;
  const tail = samples.slice(-SUSTAINED_LATENCY_SAMPLE_COUNT);
  return tail.every(
    (s) =>
      s.ok && s.latencyMs !== undefined && s.latencyMs > DEGRADED_LATENCY_MS
  );
}

/**
 * Boot-phase noise that must NOT be folded into tracking at all (#647): folding
 * it opens an outage and emits a durable `down`/`recovered` pair. Leaving the
 * state untouched makes that pair vanish by construction — do not swap this for
 * a "was suppressed" flag.
 */
export function isPendingBootProbe(
  state: GatewayRuntimeState,
  probe: GatewayProbe
): boolean {
  return probe.bootPhase === true && !probe.ok && state.status === "unknown";
}

export function applyProbe(
  state: GatewayRuntimeState,
  probe: GatewayProbe
): GatewayRuntimeState {
  const nextStatus = probe.ok ? "up" : "down";
  const transitioned = state.status !== nextStatus;

  let outages = state.outages;
  if (probe.ok && transitioned && state.status === "down") {
    const last = outages[outages.length - 1];
    if (last && last.endedAt === undefined) {
      outages = [...outages.slice(0, -1), { ...last, endedAt: probe.at }];
    }
  } else if (!probe.ok && transitioned) {
    outages = [...outages, { startedAt: probe.at }].slice(-OUTAGE_CAP);
  }

  const samples = [
    ...state.samples,
    {
      at: probe.at,
      ok: probe.ok,
      ...(probe.latencyMs === undefined ? {} : { latencyMs: probe.latencyMs }),
    },
  ].slice(-SAMPLE_CAP);
  const latencyDegraded = sustainedHighLatency(samples);

  const healthStatus = probe.ok
    ? probe.healthStatus === "error"
      ? "error"
      : probe.healthStatus === "degraded" ||
          (probe.healthStatus === "ok" && latencyDegraded)
        ? "degraded"
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
    ...(healthStatus === undefined ? {} : { healthStatus }),
    ...(probe.ok && probe.componentIssues !== undefined
      ? { componentIssues: probe.componentIssues }
      : {}),
    ...(probe.ok
      ? {
          ...(probe.latencyMs === undefined
            ? {}
            : { latencyMs: probe.latencyMs }),
          ...(probe.gatewayStartedAt === undefined
            ? {}
            : { gatewayStartedAt: probe.gatewayStartedAt }),
          ...(probe.gatewayUptimeMs === undefined
            ? {}
            : { gatewayUptimeMs: probe.gatewayUptimeMs }),
          ...(probe.version === undefined ? {} : { version: probe.version }),
          ...(probe.protocolVersion === undefined
            ? {}
            : { protocolVersion: probe.protocolVersion }),
          // REMOTE only: a local gateway ships from this tree and cannot skew.
          ...(state.gatewayKind === "remote" &&
          probe.version !== undefined &&
          probe.protocolVersion !== undefined
            ? {
                versionSkew: {
                  skewed: !protocolsCompatible({
                    localProtocol: EXPECTED_PROTOCOL_VERSION,
                    localMin: GATEWAY_MIN_PROTOCOL_VERSION,
                    peerProtocol: probe.protocolVersion,
                    peerMin: probe.protocolVersion,
                  }),
                  gatewayVersion: probe.version,
                  gatewayProtocolVersion: probe.protocolVersion,
                  clientVersion: EXPECTED_GATEWAY_VERSION,
                  clientProtocolVersion: EXPECTED_PROTOCOL_VERSION,
                } satisfies GatewayVersionSkew,
              }
            : {}),
        }
      : probe.detail === undefined
        ? {}
        : { lastError: probe.detail }),
  };
}

/**
 * Marks the outage so it never re-fires. The recovery notice pairs with an
 * already-fired down alert and lands even if alerts were toggled off mid-outage.
 */
export function evaluateAlert(
  state: GatewayRuntimeState,
  config: GatewayAlertConfig,
  now: number
): { state: GatewayRuntimeState; action?: GatewayAlertAction } {
  const last = state.outages[state.outages.length - 1];
  if (!last) return { state };

  if (state.status === "down" && last.endedAt === undefined) {
    if (!config.enabled || last.alertedAt !== undefined) return { state };
    const downForMs = now - last.startedAt;
    if (downForMs < config.thresholdSeconds * 1000) return { state };
    return {
      state: {
        ...state,
        outages: [...state.outages.slice(0, -1), { ...last, alertedAt: now }],
      },
      action: { kind: "down", downForMs },
    };
  }

  if (
    state.status === "up" &&
    last.endedAt !== undefined &&
    last.alertedAt !== undefined &&
    last.recoveredNoticeAt === undefined
  ) {
    return {
      state: {
        ...state,
        outages: [
          ...state.outages.slice(0, -1),
          { ...last, recoveredNoticeAt: now },
        ],
      },
      action: { kind: "recovered", outageMs: last.endedAt - last.startedAt },
    };
  }

  return { state };
}

export function applyComponentAlerts(
  state: GatewayRuntimeState,
  now: number,
  config: GatewayAlertConfig
): { state: GatewayRuntimeState; actions: GatewayComponentAlertAction[] } {
  const erroring = new Map(
    (state.componentIssues ?? [])
      .filter((c) => c.status === "error")
      .map((c) => [c.component, c] as const)
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
      ...(alertedAt === undefined ? {} : { alertedAt }),
    });
  }
  for (const issue of erroring.values()) {
    nextRecords.push({
      component: issue.component,
      sinceAt: now,
      ...(issue.message ? { message: issue.message } : {}),
    });
  }

  return {
    state: {
      ...state,
      componentAlerts: nextRecords.slice(-COMPONENT_ALERT_CAP),
    },
    actions,
  };
}

export function applyVersionSkewAlert(
  state: GatewayRuntimeState,
  config: GatewayAlertConfig,
  now: number
): { state: GatewayRuntimeState; action?: GatewayVersionSkewAction } {
  const skew = state.versionSkew;
  if (!skew?.skewed) {
    if (state.versionSkewAlertedAt === undefined) return { state };
    const { versionSkewAlertedAt: _cleared, ...rest } = state;
    return { state: rest as GatewayRuntimeState };
  }
  if (!config.enabled || state.versionSkewAlertedAt !== undefined)
    return { state };
  return {
    state: { ...state, versionSkewAlertedAt: now },
    action: {
      gatewayVersion: skew.gatewayVersion,
      gatewayProtocolVersion: skew.gatewayProtocolVersion,
    },
  };
}

export function formatDurationMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
