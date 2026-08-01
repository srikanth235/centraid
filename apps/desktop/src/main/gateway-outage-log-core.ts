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
 *
 * This log is the ONLY durable home for gateway health (issue #665). It was
 * briefly dual-written into the vault Notifications as well (#647); that projection is
 * gone, because health is STATUS, not a decision — marking a persistent
 * "degraded" card read never un-degrades anything, it just comes back. Health
 * reaches the owner through the Gateway page (Overview status card, Components
 * tab, and the Alerts tab that reads THIS file) plus the threshold-gated OS
 * notification in gateway-monitor.ts.
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

/**
 * Schema history:
 *   1 — events only, written by a build that never projected anything.
 *   2 — per-gateway Notifications projection marks (issue #647 review). **Legacy.**
 *   3 — marks carry the `vaultId` they were advanced against (issue #647
 *       follow-up). **Legacy.**
 *   4 — events only again (issue #665): gateway health is STATUS, not a
 *       decision, so it no longer projects into Notifications at all — it lives on
 *       the Gateway page (Overview card, Components tab, Alerts history) and
 *       in the threshold-gated OS notification. With no projection there is
 *       nothing to high-water-mark, so schema 2/3's `projection-mark` lines are
 *       dead weight: we stop WRITING them and never write a mark again.
 *
 * Reading an existing schema-3 file still works and always will: a
 * `projection-mark` line simply is not an event line (`isOutageLogEvent`
 * rejects anything carrying a `type`), so `parseOutageLogFile` skips it the
 * same way it skips the header. The marks disappear from disk the first time
 * this build rewrites the file. Nothing reads `schema` any more — the header
 * line is kept purely so the on-disk format stays self-describing.
 */
const OUTAGE_LOG_SCHEMA = 4;

/** NDJSON header line — present from schema 2 on, ignored on read. */
interface OutageLogHeaderLine {
  type: "outage-log";
  schema: number;
}

/** One newline-delimited JSON line — NDJSON, cheap to `tail`/parse (same shape as crash.log). */
function formatOutageLogLine(
  value: OutageLogEvent | OutageLogHeaderLine
): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * Serialize the whole file: a schema header, then events oldest-first
 * (unchanged shape, so an existing log stays readable).
 */
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

/**
 * Parse NDJSON content, skipping blank/malformed lines rather than failing
 * the whole read — a torn last line from a crash mid-write shouldn't lose
 * every event that came before it.
 *
 * Every non-event line is skipped by construction (`isOutageLogEvent` rejects
 * anything with a `type` field), which is what keeps a file written by any
 * earlier schema readable: the header and schema 2/3's legacy
 * `projection-mark` lines fall through here and the events survive intact.
 */
export function parseOutageLogFile(raw: string): OutageLogEvent[] {
  const events: OutageLogEvent[] = [];
  for (const line of raw.split("\n")) {
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
export function capOutageLog(
  events: OutageLogEvent[],
  cap: number
): OutageLogEvent[] {
  return events.length > cap ? events.slice(events.length - cap) : events;
}

export interface DeriveOutageEventsInput {
  /** The tracked status/healthStatus just BEFORE this tick's probe was folded in. */
  prevStatus: GatewayRuntimeState["status"];
  prevHealthStatus: GatewayRuntimeState["healthStatus"];
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
 * Why a gateway just turned `degraded`, in one line — or `undefined` when we
 * have nothing honest to say (issue #647 follow-up).
 *
 * This used to stamp `${latencyMs}ms latency` on EVERY degraded event, which
 * produced the nonsense card "Local is degraded — 4ms latency": latency only
 * degrades a gateway past `DEGRADED_LATENCY_MS` (2000ms), so a 4ms
 * reading meant the degradation actually came from a component, and the detail
 * was reporting the one number that proved it hadn't. `latencyDegraded` is the
 * flag `applyProbe` sets for the latency path, so trust it rather than the
 * raw sample, and otherwise name the components that are actually unwell.
 */
function degradedDetail(state: GatewayRuntimeState): string | undefined {
  if (state.latencyDegraded && state.latencyMs !== undefined)
    return `${state.latencyMs}ms latency`;
  const components = (state.componentIssues ?? []).map((c) => c.component);
  return components.length > 0
    ? `components: ${components.join(", ")}`
    : undefined;
}

/**
 * Derive this tick's durable alert-log events from the before/after
 * runtime state — pure, so it unit-tests without electron.
 * gateway-monitor.ts calls this once per tick, right after computing the
 * tick's alert actions, and persists the result via
 * gateway-outage-log.ts's `persistOutageEvents`.
 */
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
