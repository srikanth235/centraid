import type { CentraidGatewayRuntime } from "../../../packages/client/src/centraid-api.js";
import { gatewayJson, loadConnection, webGatewayId } from "./web-state.js";

export const HEALTH_POLL_INTERVAL_MS = 15000;

interface Tracked {
  gatewayId: string;
  trackingSince: number;
  status: CentraidGatewayRuntime["status"];
  statusSince?: number;
  checksTotal: number;
  checksFailed: number;
  samples: CentraidGatewayRuntime["samples"];
  outages: CentraidGatewayRuntime["outages"];
}

const SAMPLE_CAP = 240;
const OUTAGE_CAP = 50;

let tracked: Tracked | null = null;

function trackerFor(gatewayId: string, now: number): Tracked {
  if (tracked === null || tracked.gatewayId !== gatewayId) {
    tracked = {
      checksFailed: 0,
      checksTotal: 0,
      gatewayId,
      outages: [],
      samples: [],
      status: "unknown",
      trackingSince: now,
    };
  }
  return tracked;
}

function record(
  state: Tracked,
  probe: { at: number; ok: boolean; latencyMs?: number }
): void {
  const next = probe.ok ? "up" : "down";
  const transitioned = state.status !== next;

  if (probe.ok && transitioned && state.status === "down") {
    const open = state.outages[state.outages.length - 1];
    if (open && open.endedAt === undefined) open.endedAt = probe.at;
  } else if (!probe.ok && transitioned) {
    state.outages = [...state.outages, { startedAt: probe.at }].slice(
      -OUTAGE_CAP
    );
  }

  state.samples = [
    ...state.samples,
    {
      at: probe.at,
      ok: probe.ok,
      ...(probe.latencyMs === undefined ? {} : { latencyMs: probe.latencyMs }),
    },
  ].slice(-SAMPLE_CAP);
  state.checksTotal += 1;
  if (!probe.ok) state.checksFailed += 1;
  if (transitioned) state.statusSince = probe.at;
  state.status = next;
}

function observed(
  state: Tracked
): Pick<
  CentraidGatewayRuntime,
  "checksTotal" | "checksFailed" | "samples" | "outages" | "trackingSince"
> & { statusSince?: number } {
  return {
    checksFailed: state.checksFailed,
    checksTotal: state.checksTotal,
    outages: state.outages,
    samples: state.samples,
    trackingSince: state.trackingSince,
    ...(state.statusSince === undefined
      ? {}
      : { statusSince: state.statusSince }),
  };
}

interface CentraidGatewayHealth {
  uptimeMs: number;
  startedAt: string;
  status: NonNullable<CentraidGatewayRuntime["healthStatus"]>;
  components: Array<{
    component: string;
    status: string;
    lastError?: string;
  }>;
}

export async function healthSnapshot(): Promise<CentraidGatewayRuntime> {
  const started = performance.now();
  const connection = loadConnection();
  const gatewayId = webGatewayId(connection) ?? "web";
  const state = trackerFor(gatewayId, Date.now());
  try {
    const health = await gatewayJson<CentraidGatewayHealth>(
      "/centraid/_gateway/health"
    );
    const now = Date.now();
    const latencyMs = Math.round(performance.now() - started);
    record(state, { at: now, latencyMs, ok: true });
    return {
      gatewayId: "web",
      gatewayLabel: connection.label,
      gatewayKind: "remote",
      status: "up",
      lastCheckAt: now,
      latencyMs,
      gatewayStartedAt: Date.parse(health.startedAt),
      gatewayUptimeMs: health.uptimeMs,
      alert: { enabled: false, thresholdSeconds: 120 },
      pollIntervalMs: HEALTH_POLL_INTERVAL_MS,
      alertHistory: [],
      healthStatus: health.status,
      componentIssues: health.components
        .filter((component) => component.status !== "ok")
        .map((component) => ({
          component: component.component,
          status: component.status,
          ...(component.lastError ? { message: component.lastError } : {}),
        })),
      ...observed(state),
    };
  } catch (error) {
    const now = Date.now();
    record(state, { at: now, ok: false });
    return {
      gatewayId: "web",
      gatewayLabel: connection.label,
      gatewayKind: "remote",
      status: "down",
      lastCheckAt: now,
      lastError: error instanceof Error ? error.message : String(error),
      alert: { enabled: false, thresholdSeconds: 120 },
      pollIntervalMs: HEALTH_POLL_INTERVAL_MS,
      alertHistory: [],
      ...observed(state),
    };
  }
}

export function resetHealthTracking(): void {
  tracked = null;
}
