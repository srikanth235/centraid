/*
 * Telemetry surface — in-process interface the runtime uses to record
 * handler invocations (spans) and user-emitted log events.
 *
 * The runtime doesn't implement this; the host (openclaw-plugin) injects
 * a `TelemetryWriter` whose backing store lives at plugin scope — one
 * shared SQLite file across all apps, mirroring `chat-history`. That keeps
 * telemetry out of each app's user-visible `data.sqlite` (so it's not
 * reachable from agent `centraid_sql_*` tools) and avoids schema migrations
 * across N app DBs.
 *
 * Caps and TTL semantics are described on `TelemetrySpanRecord` and
 * implemented by the store, not the runtime — the runtime only buffers
 * per-invocation events and forwards them in one batched `recordHandler`
 * call at handler completion (see handler-runner.ts).
 */

export type TelemetryLevel = 'info' | 'warn' | 'error';
export type TelemetryKind = 'query' | 'action' | 'cron';
export type TelemetryStatus = 'ok' | 'error';

export interface TelemetryEvent {
  ts: number;
  level: TelemetryLevel;
  msg: string;
}

export interface TelemetrySpanRecord {
  appId: string;
  traceId: string;
  spanId: string;
  parentId?: string;
  kind: TelemetryKind;
  handler: string;
  startedAt: number;
  durationMs: number;
  status: TelemetryStatus;
  error?: string;
  /**
   * Ordered events emitted during the invocation. The writer applies its
   * own per-record caps (count, byte size) before persisting; callers
   * don't need to truncate.
   */
  events: TelemetryEvent[];
}

export interface TelemetryReadOptions {
  /** Default 100, hard-capped by the writer. */
  limit?: number;
  /** Drop entries with `ts < sinceTs` (polling tail). */
  sinceTs?: number;
  /** Restrict to a single level. */
  level?: TelemetryLevel;
}

export interface TelemetryReadEntry {
  ts: number;
  level: TelemetryLevel;
  msg: string;
  source: TelemetryKind;
  handler: string;
}

/**
 * Per-app controls over what the writer persists. Stored in the writer's
 * own DB (not the app's `data.sqlite`), keyed by `app_id`. Missing keys
 * fall back to writer defaults — callers don't need to upsert defaults.
 *
 * The trade-off menu is deliberately small at this scale:
 *   - `enabled=false` → drop everything for the app (spans and events).
 *   - `minLevel` → drop events below this level *before* writing. Spans
 *     are always written when `enabled=true`, regardless of `minLevel`,
 *     because failure rate/latency metrics are derived from them.
 *   - `retentionDaysOverrides` → override TTL buckets in days. Any key
 *     omitted keeps the writer's default. Useful when a user wants a
 *     chatty app to retain longer (or shorter) than the platform default.
 */
export interface TelemetryAppSettings {
  enabled: boolean;
  minLevel: TelemetryLevel;
  retentionDaysOverrides?: {
    eventInfo?: number;
    eventWarn?: number;
    eventError?: number;
    spanOk?: number;
    spanErr?: number;
  };
}

/** Patch shape passed to `setAppSettings` — every key is optional. */
export interface TelemetryAppSettingsPatch {
  enabled?: boolean;
  minLevel?: TelemetryLevel;
  retentionDaysOverrides?: TelemetryAppSettings['retentionDaysOverrides'];
}

export interface TelemetryWriter {
  /**
   * Persist a completed handler invocation (one span + N events) in a
   * single transaction. Best-effort: implementations must not throw — the
   * runtime treats failures as silent drops to avoid coupling user
   * request latency to the telemetry store.
   */
  recordHandler(record: TelemetrySpanRecord): Promise<void>;

  /** Read recent events for an app, newest-first, applying level/sinceTs. */
  readEvents(appId: string, opts?: TelemetryReadOptions): Promise<TelemetryReadEntry[]>;

  /**
   * Drop all telemetry rows for an app. Called from `deregister` cleanup
   * so a removed app doesn't leave orphan rows behind. Also clears the
   * per-app settings row.
   */
  deleteApp(appId: string): Promise<void>;

  /** Effective settings for an app (filled with writer defaults). */
  getAppSettings(appId: string): Promise<TelemetryAppSettings>;

  /**
   * Merge a patch into the app's settings row. Missing keys retain their
   * current value (or default if no row exists yet). The writer's
   * settings cache is invalidated synchronously.
   */
  setAppSettings(appId: string, patch: TelemetryAppSettingsPatch): Promise<TelemetryAppSettings>;
}
