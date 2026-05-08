import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { AppRef } from '../types.js';

const WORKER_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'worker',
  'runner.js',
);

export interface RunHandlerOptions {
  app: AppRef;
  handlerFile: string;
  handlerKind: 'query' | 'action' | 'cron';
  args: Record<string, unknown>;
  timeoutMs?: number;
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

  return await new Promise<HandlerOutcome>((resolve) => {
    const finish = (outcome: HandlerOutcome) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      try {
        db.close();
      } catch {
        /* ignore */
      }
      worker.removeAllListeners();
      worker.terminate().catch(() => {});
      resolve(outcome);
    };

    worker.on('message', (msg: { type: string }) => {
      if (msg.type === 'db') {
        const call = msg as unknown as DbCall;
        const reply = handleDb(call);
        worker.postMessage({ type: 'db-reply', id: call.id, ...reply });
      } else if (msg.type === 'log') {
        const m = msg as unknown as { level: 'info' | 'warn' | 'error'; msg: string };
        logs.push({ level: m.level, msg: m.msg });
      } else if (msg.type === 'result') {
        const r = msg as unknown as { ok: boolean; value?: unknown; error?: string };
        finish({ ok: r.ok, value: r.value, error: r.error, logs });
      }
    });
    worker.on('error', (err) => finish({ ok: false, error: err.message, logs }));
    worker.on('exit', (code) => {
      if (code !== 0) finish({ ok: false, error: `worker exited with code ${code}`, logs });
    });
  });
}
