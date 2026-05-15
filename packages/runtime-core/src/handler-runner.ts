import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { AppRef } from './types.js';
import { appendLogs, type LogEntry } from './log-store.js';
import { trackChanges } from './change-tracker.js';

const WORKER_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker', 'runner.js');

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
  const persistedEntries: LogEntry[] = [];

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
      // Fire-and-forget log persistence — see log-store.ts for the rotation
      // story. Resolving the outcome is independent of the disk write.
      if (persistedEntries.length > 0) {
        void appendLogs(opts.app.dir, persistedEntries);
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
        persistedEntries.push({
          ts: Date.now(),
          level: m.level,
          msg: m.msg,
          source: opts.handlerKind,
          handler: handlerName,
        });
      } else if (msg.type === 'result') {
        const r = msg as unknown as { ok: boolean; value?: unknown; error?: string };
        // If the handler failed, also persist an error log so the Logs panel
        // surfaces the failure even when the user didn't call `log.error`.
        if (!r.ok && r.error) {
          persistedEntries.push({
            ts: Date.now(),
            level: 'error',
            msg: `${opts.handlerKind} handler failed: ${r.error}`,
            source: opts.handlerKind,
            handler: handlerName,
          });
        }
        finish({ ok: r.ok, value: r.value, error: r.error, logs });
      }
    });
    worker.on('error', (err) => {
      persistedEntries.push({
        ts: Date.now(),
        level: 'error',
        msg: `worker error: ${err.message}`,
        source: opts.handlerKind,
        handler: handlerName,
      });
      finish({ ok: false, error: err.message, logs });
    });
    worker.on('exit', (code) => {
      if (code !== 0) {
        persistedEntries.push({
          ts: Date.now(),
          level: 'error',
          msg: `worker exited with code ${code}`,
          source: opts.handlerKind,
          handler: handlerName,
        });
        finish({ ok: false, error: `worker exited with code ${code}`, logs });
      }
    });
  });
}
