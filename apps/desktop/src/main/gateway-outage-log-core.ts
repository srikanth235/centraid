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

export interface GatewayInboxEvent {
  sourceRef: string;
  headline: string;
  severity: "info" | "warning" | "high";
  at: string;
  detail: Record<string, unknown>;
}

/**
 * The `(kind, source_ref)` scope a transition collapses within. Everything
 * about a gateway as a whole shares one scope; a component error is scoped to
 * the component, so a flapping `connections` component can't bury a separate
 * `vaults` failure under the same card.
 *
 * `detail` for a component-error is `"<component>: <message>"` (see
 * `deriveOutageEvents`) — only the component part is identity, because the
 * message is the volatile bit (`ETIMEDOUT` one tick, `ECONNRESET` the next).
 */
function inboxScope(event: OutageLogEvent): string {
  if (event.kind !== "component-error") return "gateway";
  const detail = event.detail ?? "";
  const separator = detail.indexOf(":");
  const component = (
    separator === -1 ? detail : detail.slice(0, separator)
  ).trim();
  return component || "gateway";
}

/**
 * Project one durable monitor event into an Inbox write.
 *
 * The source identity is STABLE per (gateway, scope, transition kind) — it
 * deliberately does NOT include the event timestamp (issue #647 review). A
 * gateway that flaps every 30s used to mint a brand-new high-severity card
 * (and a wake push to every paired device) per transition, because each `at`
 * made a distinct `(kind, source_ref)` pair the server's collapse-on-write
 * could never match. With the timestamp moved into the detail payload
 * (`occurredAt`), repeat transitions collapse server-side into one card with a
 * bumped count, while `down` / `recovered` / `degraded` stay distinct cards
 * because the transition kind is part of the ref.
 *
 * This depends on the gateway route calling `InboxNoticeStore.put` (collapse)
 * rather than `putIfAbsent` (dedupe) — see COORDINATION-gateway-health.md.
 * Client-side at-most-once delivery is now the projection high-water mark's
 * job ({@link eventsAfterMark}), not the server's.
 */
export function gatewayInboxEvent(event: OutageLogEvent): GatewayInboxEvent {
  const headline =
    event.kind === "recovered"
      ? `${event.gatewayLabel} recovered`
      : event.kind === "down"
        ? `${event.gatewayLabel} is unreachable`
        : event.kind === "degraded"
          ? `${event.gatewayLabel} is degraded`
          : event.kind === "version-skew"
            ? `${event.gatewayLabel} has a version mismatch`
            : `${event.gatewayLabel} has an unhealthy component`;
  return {
    sourceRef: [
      "gateway-health",
      event.gatewayId,
      inboxScope(event),
      event.kind,
    ].join(":"),
    headline,
    severity:
      event.kind === "recovered"
        ? "info"
        : event.kind === "degraded"
          ? "warning"
          : "high",
    at: new Date(event.at).toISOString(),
    detail: {
      sourceType: "app",
      gatewayId: event.gatewayId,
      gatewayLabel: event.gatewayLabel,
      outcome: event.kind,
      // Carries what the source ref used to encode: the exact moment of THIS
      // transition. On a collapsed card the server's `last_at` tracks the most
      // recent occurrence and this is its detail-level copy.
      occurredAt: new Date(event.at).toISOString(),
      ...(event.detail ? { detail: event.detail } : {}),
      ...(event.durationMs === undefined
        ? {}
        : { durationMs: event.durationMs }),
      deepLink: "/gateway/alerts",
    },
  };
}

/** Bound on the persisted log — a chatty gateway can't grow this file forever. */
export const OUTAGE_LOG_CAP = 500;

/**
 * Server-side validation cap on one `POST /centraid/_vault/inbox/gateway-health`
 * body (`vault-routes.ts`: "gateway-health body needs 1–100 events"). A backlog
 * larger than this drains OLDEST-first across successive ticks rather than
 * being truncated — the high-water mark only ever advances over events that
 * actually landed.
 */
export const INBOX_FLUSH_BATCH = 100;

/**
 * How far Inbox projection has got for one gateway (issue #647 review).
 *
 * Persisted alongside the events in the same NDJSON file, so projection is
 * at-most-once across restarts AND across active-vault switches: before this,
 * replay was keyed per-launch by gatewayId while the write targeted whatever
 * vault happened to be active, so relaunching with a different vault active
 * projected the whole history a second time into that vault.
 *
 * It is the event's own identity rather than a bare index because the log is
 * capped (older entries roll off, shifting every index) — `at` alone is the
 * fallback for a mark whose event has already rolled off.
 */
export interface InboxProjectionMark {
  at: number;
  kind: OutageLogEventKind;
  detail?: string;
}

/** The mark that means "this event and everything before it is projected". */
export function outageEventMark(event: OutageLogEvent): InboxProjectionMark {
  return {
    at: event.at,
    kind: event.kind,
    ...(event.detail === undefined ? {} : { detail: event.detail }),
  };
}

function marksEvent(event: OutageLogEvent, mark: InboxProjectionMark): boolean {
  return (
    event.at === mark.at &&
    event.kind === mark.kind &&
    (event.detail ?? undefined) === mark.detail
  );
}

/**
 * The still-unprojected tail of one gateway's durable history, oldest-first.
 *
 * With no mark this returns EVERYTHING — the caller decides whether that is a
 * genuinely new gateway (flush it) or a log written before marks existed
 * (seed the mark at the end and flush nothing; see gateway-monitor.ts). Anchor
 * on the marked event's position when it's still in the log, so two events
 * recorded in the same millisecond can't be conflated; fall back to a
 * timestamp comparison once it has rolled off the cap.
 */
export function eventsAfterMark(
  events: readonly OutageLogEvent[],
  mark: InboxProjectionMark | undefined
): OutageLogEvent[] {
  if (!mark) return [...events];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event && marksEvent(event, mark)) return events.slice(i + 1);
  }
  return events.filter((event) => event.at > mark.at);
}

/**
 * Resolve where (if anywhere) this tick may project, or `undefined` to skip.
 *
 * `vaultId` is checked for TRUTHINESS, not merely `!== undefined` (issue #647
 * review): sibling desktop code stores an unset active vault as `""`, so the
 * old `!== undefined` guard let `""` through and every flush then 4xx'd
 * forever on an empty `x-centraid-vault` header. Returning the resolved target
 * rather than a boolean keeps the caller's narrowing honest — there is exactly
 * one place that decides, and it can't drift from a second inline check.
 */
export function inboxProjectionTarget(input: {
  probeOk: boolean;
  gatewayUrl: string | undefined;
  vaultId: string | undefined;
  pendingCount: number;
}): { gatewayUrl: string; vaultId: string } | undefined {
  if (!input.probeOk || input.pendingCount === 0) return undefined;
  if (!input.gatewayUrl || !input.vaultId) return undefined;
  return { gatewayUrl: input.gatewayUrl, vaultId: input.vaultId };
}

/**
 * Bumped when projection marks were introduced (issue #647 review). A log
 * without the header line is schema 1 — written by a build that never
 * projected anything, so its whole history must be treated as already-seen
 * rather than replayed. In a schema-2 log a MISSING mark means the opposite:
 * this gateway genuinely has nothing projected yet, so its backlog is real and
 * must be flushed (an outage recorded while the gateway was unreachable, whose
 * flush hadn't happened before the desktop restarted).
 */
export const OUTAGE_LOG_SCHEMA = 2;
const LEGACY_OUTAGE_LOG_SCHEMA = 1;

/** The whole persisted log: the events plus per-gateway projection marks. */
export interface OutageLogFile {
  /** {@link OUTAGE_LOG_SCHEMA}, or 1 for a log written before marks existed. */
  schema: number;
  events: OutageLogEvent[];
  /** Keyed by `gatewayId`. Absent key in a schema-2 log = nothing projected. */
  projected: Record<string, InboxProjectionMark>;
}

/** NDJSON line shape for a projection mark — discriminated from event lines. */
interface ProjectionMarkLine extends InboxProjectionMark {
  type: "projection-mark";
  gatewayId: string;
}

/** NDJSON header line — present from schema 2 on. */
interface OutageLogHeaderLine {
  type: "outage-log";
  schema: number;
}

/**
 * The upgrade path (issue #647 review): adopt every gateway's history as
 * already-projected WITHOUT flushing any of it.
 *
 * Before this, the first launch after upgrading replayed up to 100 stale
 * transitions as fresh unread high-severity Inbox cards, each one waking every
 * paired device — a storm about outages the owner lived through weeks ago.
 * Owners get only transitions observed from here on.
 */
export function seedProjectionMarks(file: OutageLogFile): OutageLogFile {
  if (file.schema >= OUTAGE_LOG_SCHEMA) return file;
  const projected: Record<string, InboxProjectionMark> = { ...file.projected };
  for (const event of file.events)
    projected[event.gatewayId] = outageEventMark(event);
  return { schema: OUTAGE_LOG_SCHEMA, events: file.events, projected };
}

/** One newline-delimited JSON line — NDJSON, cheap to `tail`/parse (same shape as crash.log). */
function formatOutageLogLine(
  value: OutageLogEvent | ProjectionMarkLine | OutageLogHeaderLine
): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * Serialize the whole file: a schema header, then events oldest-first
 * (unchanged shape, so an existing log stays readable), then one
 * `projection-mark` line per gateway. Marks go LAST so a torn tail costs at
 * most a re-projection window, never an event.
 */
export function formatOutageLogFile(file: OutageLogFile): string {
  return [
    formatOutageLogLine({ type: "outage-log", schema: OUTAGE_LOG_SCHEMA }),
    ...file.events.map(formatOutageLogLine),
    ...Object.entries(file.projected).map(([gatewayId, mark]) =>
      formatOutageLogLine({ type: "projection-mark", gatewayId, ...mark })
    ),
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

function isHeaderLine(value: unknown): value is OutageLogHeaderLine {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return rec.type === "outage-log" && typeof rec.schema === "number";
}

function isProjectionMarkLine(value: unknown): value is ProjectionMarkLine {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    rec.type === "projection-mark" &&
    typeof rec.gatewayId === "string" &&
    typeof rec.at === "number" &&
    typeof rec.kind === "string" &&
    (KINDS as readonly string[]).includes(rec.kind) &&
    (rec.detail === undefined || typeof rec.detail === "string")
  );
}

/**
 * Parse NDJSON content, skipping blank/malformed lines rather than failing
 * the whole read — a torn last line from a crash mid-write shouldn't lose
 * every event that came before it. A log written before projection marks
 * existed parses fine and simply yields no marks (the upgrade path).
 */
export function parseOutageLogFile(raw: string): OutageLogFile {
  const events: OutageLogEvent[] = [];
  const projected: Record<string, InboxProjectionMark> = {};
  let schema = LEGACY_OUTAGE_LOG_SCHEMA;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isOutageLogEvent(parsed)) {
        events.push(parsed);
      } else if (isHeaderLine(parsed)) {
        schema = parsed.schema;
      } else if (isProjectionMarkLine(parsed)) {
        projected[parsed.gatewayId] = {
          at: parsed.at,
          kind: parsed.kind,
          ...(parsed.detail === undefined ? {} : { detail: parsed.detail }),
        };
      }
    } catch {
      // Skip a torn/corrupt line — best-effort read, not a hard failure.
    }
  }
  return { schema, events, projected };
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
    events.push({
      at: eventAt,
      kind: "degraded",
      ...base,
      ...(state.latencyMs === undefined
        ? {}
        : { detail: `${state.latencyMs}ms latency` }),
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
      detail: `v${versionSkewAction.gatewayVersion} (schema ${versionSkewAction.gatewaySchemaEpoch})`,
    });
  }

  return events;
}
