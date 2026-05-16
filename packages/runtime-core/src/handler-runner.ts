import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { AppRef } from './types.js';
import { appendLogs, type LogEntry } from './log-store.js';
import { trackChanges } from './change-tracker.js';
import type { TelemetryEvent, TelemetryWriter } from './telemetry.js';

const WORKER_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker', 'runner.js');

/**
 * Cap on events buffered in-memory per invocation. Mirrors the store's
 * `MAX_EVENTS_PER_RECORD` cap so we don't burn RAM on a runaway logger
 * before the writer truncates. Excess events are dropped here; the
 * writer adds the "events truncated" marker if its cap is also tripped.
 */
const MAX_EVENTS_BUFFERED = 1000;

export interface RunHandlerOptions {
  app: AppRef;
  handlerFile: string;
  handlerKind: 'query' | 'action' | 'cron';
  args: Record<string, unknown>;
  timeoutMs?: number;
  /**
   * Fired once after the handler completes with the list of tables the
   * handler's writes touched (deduplicated, sorted). Skipped for query
   * handlers — they're nominally read-only and even if they sneak a write
   * through we treat it as "library author's problem", not a notify event.
   * Empty list = no writes; the call is suppressed.
   */
  onWrite?: (tables: string[]) => void;
  /**
   * Plugin-scope telemetry sink. When provided, the runner emits one
   * span (with N events) per invocation via `recordHandler`. When
   * omitted, falls back to per-app `logs.jsonl` (legacy path — being
   * phased out as hosts migrate to the shared store).
   */
  telemetry?: TelemetryWriter;
  /** W3C-style 32-hex trace id when this invocation is part of a larger
   *  trace (e.g. a cron dispatch). Defaults to a fresh id. */
  traceId?: string;
  /** Parent span id (16 hex), for the same case. */
  parentSpanId?: string;
}

export interface HandlerOutcome {
  ok: boolean;
  value?: unknown;
  error?: string;
  logs: Array<{ level: 'info' | 'warn' | 'error'; msg: string }>;
}

/**
 * Runs a user handler in a worker thread with a scoped sqlite proxy.
 *
 * The worker round-trips db calls back here so the plugin owns the
 * better-sqlite3 connection (the worker never sees a path to another
 * app's database).
 */
export async function runHandler(opts: RunHandlerOptions): Promise<HandlerOutcome> {
  const dbFile = path.join(opts.app.dir, 'data.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  // Wrap the connection in a session so we can enumerate touched tables
  // for the change-notification feed at the end of the turn. Query
  // handlers skip the session — they're nominally read-only and most
  // produce empty changesets, but skipping the wrap saves the session
  // allocation entirely.
  const tracker = opts.handlerKind !== 'query' && opts.onWrite ? trackChanges(db) : undefined;

  const logs: HandlerOutcome['logs'] = [];

  const worker = new Worker(WORKER_FILE, {
    workerData: {
      handlerFile: opts.handlerFile,
      handlerKind: opts.handlerKind,
      args: { ...opts.args, app: { id: opts.app.id, dir: opts.app.dir } },
    },
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
  });

  let timeoutHandle: NodeJS.Timeout | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      worker.terminate().catch(() => {});
    }, opts.timeoutMs);
  }

  type DbCall = {
    type: 'db';
    id: number;
    method: 'exec' | 'prepare-run' | 'prepare-get' | 'prepare-all' | 'transaction-run';
    payload: {
      sql?: string;
      params?: unknown[];
      begin?: boolean;
      commit?: boolean;
      rollback?: boolean;
    };
  };

  const handleDb = (msg: DbCall): { ok: boolean; result?: unknown; error?: string } => {
    try {
      switch (msg.method) {
        case 'exec':
          db.exec(String(msg.payload.sql ?? ''));
          return { ok: true };
        case 'prepare-run': {
          const stmt = db.prepare(String(msg.payload.sql ?? ''));
          const params = (msg.payload.params ?? []) as SQLInputValue[];
          const r = stmt.run(...params);
          return { ok: true, result: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } };
        }
        case 'prepare-get': {
          const stmt = db.prepare(String(msg.payload.sql ?? ''));
          const params = (msg.payload.params ?? []) as SQLInputValue[];
          return { ok: true, result: stmt.get(...params) };
        }
        case 'prepare-all': {
          const stmt = db.prepare(String(msg.payload.sql ?? ''));
          const params = (msg.payload.params ?? []) as SQLInputValue[];
          return { ok: true, result: stmt.all(...params) };
        }
        case 'transaction-run': {
          if (msg.payload.begin) db.exec('BEGIN');
          else if (msg.payload.commit) db.exec('COMMIT');
          else if (msg.payload.rollback) db.exec('ROLLBACK');
          return { ok: true };
        }
        default:
          return { ok: false, error: `unknown db method: ${(msg as { method: string }).method}` };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const handlerName = path.basename(opts.handlerFile).replace(/\.js$/, '');
  const traceId = opts.traceId ?? randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  const startedAt = Date.now();

  // Two buffers tracked in parallel: `legacyEntries` feeds the per-app
  // `logs.jsonl` fallback when no telemetry sink is wired; `events` is
  // shipped as one batched `recordHandler` call when one is. Both share
  // `MAX_EVENTS_BUFFERED` so a runaway handler can't pin RAM.
  //
  // We hold back one slot from user events for the truncation marker
  // `finish()` writes, so a handler that emits exactly `MAX_EVENTS_BUFFERED`
  // events doesn't silently lose the "events dropped" warning when the
  // buffer is full.
  const USER_EVENT_CAP = MAX_EVENTS_BUFFERED - 1;
  const legacyEntries: LogEntry[] = [];
  const events: TelemetryEvent[] = [];
  let droppedEvents = 0;
  const recordEvent = (level: 'info' | 'warn' | 'error', msg: string): void => {
    if (events.length >= USER_EVENT_CAP) {
      droppedEvents += 1;
      return;
    }
    const ts = Date.now();
    events.push({ ts, level, msg });
    if (!opts.telemetry) {
      legacyEntries.push({ ts, level, msg, source: opts.handlerKind, handler: handlerName });
    }
  };
  // Unconditional append for the truncation marker — bypasses the cap so
  // the reserved slot above is actually used. Caller must only emit one
  // marker per invocation.
  const recordMarker = (msg: string): void => {
    const ts = Date.now();
    events.push({ ts, level: 'warn', msg });
    if (!opts.telemetry) {
      legacyEntries.push({
        ts,
        level: 'warn',
        msg,
        source: opts.handlerKind,
        handler: handlerName,
      });
    }
  };

  return await new Promise<HandlerOutcome>((resolve) => {
    let resolved = false;
    const finish = (outcome: HandlerOutcome) => {
      if (resolved) return;
      resolved = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      // Snapshot touched tables BEFORE closing the connection — sessions
      // are tied to the connection's lifetime. Only fire the notifier on
      // successful turns; a thrown handler may have rolled back via an
      // ambient transaction, in which case the changeset is moot. The
      // notifier itself is wrapped so a thrown listener can't keep us
      // from closing the db handle.
      if (tracker && opts.onWrite && outcome.ok) {
        try {
          const tables = tracker.extract();
          if (tables.length > 0) opts.onWrite(tables);
        } catch {
          /* never let tracking change the handler outcome */
        }
      } else {
        tracker?.close();
      }
      try {
        db.close();
      } catch {
        /* ignore */
      }
      worker.removeAllListeners();
      worker.terminate().catch(() => {});

      if (droppedEvents > 0) {
        // Surface the drop so the UI shows a clear marker rather than
        // silently losing tail events. Uses `recordMarker` (not
        // `recordEvent`) because the buffer is by definition at its
        // user-event cap here, so a normal append would drop the marker
        // too. The cap reserves one slot precisely for this.
        recordMarker(`[handler-runner] dropped ${droppedEvents} events after in-memory cap`);
      }

      // Fire-and-forget persistence — never block the handler response on
      // the telemetry write. Errors in the writer are swallowed (the store
      // is expected to be defensive; see telemetry.ts admission control).
      if (opts.telemetry) {
        void opts.telemetry
          .recordHandler({
            appId: opts.app.id,
            traceId,
            spanId,
            parentId: opts.parentSpanId,
            kind: opts.handlerKind,
            handler: handlerName,
            startedAt,
            durationMs: Date.now() - startedAt,
            status: outcome.ok ? 'ok' : 'error',
            error: outcome.error,
            events,
          })
          .catch(() => {});
      } else if (legacyEntries.length > 0) {
        void appendLogs(opts.app.dir, legacyEntries);
      }
      // The `resolved` guard above makes this safe across multiple finish() callers
      // eslint-disable-next-line promise/no-multiple-resolved
      resolve(outcome);
    };

    worker.on('message', (msg: { type: string }) => {
      if (msg.type === 'db') {
        const call = msg as unknown as DbCall;
        const reply = handleDb(call);
        // node:worker_threads postMessage signature has no targetOrigin
        // eslint-disable-next-line unicorn/require-post-message-target-origin
        worker.postMessage({ type: 'db-reply', id: call.id, ...reply });
      } else if (msg.type === 'log') {
        const m = msg as unknown as { level: 'info' | 'warn' | 'error'; msg: string };
        logs.push({ level: m.level, msg: m.msg });
        recordEvent(m.level, m.msg);
      } else if (msg.type === 'result') {
        const r = msg as unknown as { ok: boolean; value?: unknown; error?: string };
        // If the handler failed, also persist an error log so the Logs panel
        // surfaces the failure even when the user didn't call `log.error`.
        if (!r.ok && r.error) {
          recordEvent('error', `${opts.handlerKind} handler failed: ${r.error}`);
        }
        finish({ ok: r.ok, value: r.value, error: r.error, logs });
      }
    });
    worker.on('error', (err) => {
      recordEvent('error', `worker error: ${err.message}`);
      finish({ ok: false, error: err.message, logs });
    });
    worker.on('exit', (code) => {
      if (code !== 0) {
        recordEvent('error', `worker exited with code ${code}`);
        finish({ ok: false, error: `worker exited with code ${code}`, logs });
      }
    });
  });
}
