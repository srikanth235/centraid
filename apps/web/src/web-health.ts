import type { CentraidGatewayRuntime } from "../../../packages/client/src/centraid-api.js";
import { gatewayJson, loadConnection } from "./web-state.js";

export const HEALTH_POLL_INTERVAL_MS = 15000;

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
  try {
    const health = await gatewayJson<CentraidGatewayHealth>(
      "/centraid/_gateway/health"
    );
    const now = Date.now();
    return {
      gatewayId: "web",
      gatewayLabel: loadConnection().label,
      gatewayKind: "remote",
      trackingSince: now - health.uptimeMs,
      status: "up",
      statusSince: now - health.uptimeMs,
      lastCheckAt: now,
      latencyMs: Math.round(performance.now() - started),
      gatewayStartedAt: Date.parse(health.startedAt),
      gatewayUptimeMs: health.uptimeMs,
      checksTotal: 1,
      checksFailed: 0,
      samples: [],
      outages: [],
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
    };
  } catch (error) {
    return {
      gatewayId: "web",
      gatewayLabel: loadConnection().label,
      gatewayKind: "remote",
      trackingSince: Date.now(),
      status: "down",
      lastCheckAt: Date.now(),
      lastError: error instanceof Error ? error.message : String(error),
      checksTotal: 1,
      checksFailed: 1,
      samples: [],
      outages: [],
      alert: { enabled: false, thresholdSeconds: 120 },
      pollIntervalMs: HEALTH_POLL_INTERVAL_MS,
      alertHistory: [],
    };
  }
}
