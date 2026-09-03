/*
 * Pure outage/alert log logic (Electron-free; `gateway-outage-log.ts` wires the
 * filesystem). The ONLY durable home for gateway health (#665) — never
 * dual-write it into vault Notifications: health is STATUS, not a decision.
 */
import type {
  GatewayComponentAlertAction,
  GatewayRuntimeState,
  GatewayVersionSkewAction,
} from "./gateway-monitor-core.js";

export type OutageLogEventKind =
  | "down"
  | "degraded"
  | "component-error"
  | "version-skew"
  | "recovered";

export interface OutageLogEvent {
  at: number;
  kind: OutageLogEventKind;
  gatewayId: string;
  gatewayLabel: string;
  detail?: string;
  durationMs?: number;
}

export const OUTAGE_LOG_CAP = 500;

/** Never write a `projection-mark` line again (#665); old ones stay readable. */
const OUTAGE_LOG_SCHEMA = 4;

interface OutageLogHeaderLine {
  type: "outage-log";
  schema: number;
}

function formatOutageLogLine(
  value: OutageLogEvent | OutageLogHeaderLine
): string {
  return `${JSON.stringify(value)}\n`;
}

export function formatOutageLogFile(events: readonly OutageLogEvent[]): string {
  return [
    formatOutageLogLine({ type: "outage-log", schema: OUTAGE_LOG_SCHEMA }),
    ...events.map(formatOutageLogLine),
  ].join("");
}

const KINDS: readonly OutageLogEventKind[] = [
  "down",
  "degraded",
  "component-error",
  "version-skew",
  "recovered",
];

function isOutageLogEvent(value: unknown): value is OutageLogEvent {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    rec.type === undefined &&
    typeof rec.at === "number" &&
    typeof rec.kind === "string" &&
    (KINDS as readonly string[]).includes(rec.kind) &&
    typeof rec.gatewayId === "string" &&
    typeof rec.gatewayLabel === "string"
  );
}

export function parseOutageLogFile(raw: string): OutageLogEvent[] {
  const events: OutageLogEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isOutageLogEvent(parsed)) events.push(parsed);
    } catch {
      // Intentionally empty.
    }
  }
  return events;
}

export function capOutageLog(
  events: OutageLogEvent[],
  cap: number
): OutageLogEvent[] {
  return events.length > cap ? events.slice(events.length - cap) : events;
}

export interface DeriveOutageEventsInput {
  prevStatus: GatewayRuntimeState["status"];
  prevHealthStatus: GatewayRuntimeState["healthStatus"];
  state: GatewayRuntimeState;
  componentActions: GatewayComponentAlertAction[];
  versionSkewAction?: GatewayVersionSkewAction;
  now: number;
}

/** Latency detail only when `latencyDegraded`: a 4ms sample disproves it (#647). */
function degradedDetail(state: GatewayRuntimeState): string | undefined {
  if (state.latencyDegraded && state.latencyMs !== undefined)
    return `${state.latencyMs}ms latency`;
  const components = (state.componentIssues ?? []).map((c) => c.component);
  return components.length > 0
    ? `components: ${components.join(", ")}`
    : undefined;
}

export function deriveOutageEvents(
  input: DeriveOutageEventsInput
): OutageLogEvent[] {
  const {
    prevStatus,
    prevHealthStatus,
    state,
    componentActions,
    versionSkewAction,
    now,
  } = input;
  const events: OutageLogEvent[] = [];
  const eventAt = state.lastCheckAt ?? now;
  const base = { gatewayId: state.gatewayId, gatewayLabel: state.gatewayLabel };

  if (prevStatus !== "down" && state.status === "down") {
    events.push({
      at: eventAt,
      kind: "down",
      ...base,
      ...(state.lastError ? { detail: state.lastError } : {}),
    });
  }

  if (prevStatus === "down" && state.status === "up") {
    const closed = state.outages[state.outages.length - 1];
    events.push({
      at: eventAt,
      kind: "recovered",
      ...base,
      ...(closed?.endedAt === undefined
        ? {}
        : { durationMs: closed.endedAt - closed.startedAt }),
    });
  }

  if (prevHealthStatus !== "degraded" && state.healthStatus === "degraded") {
    const detail = degradedDetail(state);
    events.push({
      at: eventAt,
      kind: "degraded",
      ...base,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  for (const action of componentActions) {
    events.push({
      at: now,
      kind: "component-error",
      ...base,
      detail: action.message
        ? `${action.component}: ${action.message}`
        : action.component,
      durationMs: action.downForMs,
    });
  }

  if (versionSkewAction) {
    events.push({
      at: now,
      kind: "version-skew",
      ...base,
      detail: `v${versionSkewAction.gatewayVersion} (protocol ${versionSkewAction.gatewayProtocolVersion})`,
    });
  }

  return events;
}
