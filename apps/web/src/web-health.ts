import type { CentraidGatewayRuntime } from "../../../packages/client/src/centraid-api.js";
import { gatewayJson, loadConnection, webGatewayId } from "./web-state.js";

export const HEALTH_POLL_INTERVAL_MS = 15000;

/**
 * THE WEB SEAT REMEMBERS ITS OWN HEARTBEATS.
 *
 * Every field on `CentraidGatewayRuntime` that describes a WINDOW rather than
 * an instant — `checksTotal`, `checksFailed`, `samples`, `outages`,
 * `statusSince`, `trackingSince` — used to be rebuilt from nothing on each
 * poll, so this seat reported `1 checks this session · 100.0%` forever, the
 * Heartbeats row read `1 run · 0 failed` after an hour of running, and the
 * sample ring the System page draws its availability strip from was
 * permanently empty. Desktop keeps this state in the main process
 * (`gateway-monitor-core.ts`); the browser has no main process, so it keeps it
 * here.
 *
 * Deliberately IN MEMORY and per-tab, matching desktop's per-launch posture:
 * this is the session's own record of what it observed, not a durable history
 * of the gateway. The System page says "this session" for exactly that reason.
 */
interface Tracked {
  /** Which gateway this history belongs to — a switch resets it. */
  gatewayId: string;
  trackingSince: number;
  status: CentraidGatewayRuntime["status"];
  statusSince?: number;
  checksTotal: number;
  checksFailed: number;
  samples: CentraidGatewayRuntime["samples"];
  outages: CentraidGatewayRuntime["outages"];
}

/** Same ring size as the desktop monitor's `SAMPLE_CAP`, so both seats fold
 *  the same amount of evidence into the strip. */
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

/** Fold one probe into the tracked window. Mirrors `applyProbe`'s transition
 *  rules: an outage opens on the edge into `down` and closes on the edge back
 *  out, so a stretch of failures is one outage rather than one per probe. */
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

/** The window fields, spread onto whichever snapshot the probe produced. */
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

/** Test seam: forget this seat's observed window. */
export function resetHealthTracking(): void {
  tracked = null;
}
