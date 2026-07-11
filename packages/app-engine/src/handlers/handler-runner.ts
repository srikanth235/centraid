import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppRef } from '../types.js';
import { appendLogs, type LogEntry } from '../data/log-store.js';
import type { VaultBridge, VaultOp } from './vault-bridge.js';
import { sharedWorkerAdmission, type WorkerAdmission } from './worker-admission.js';

function resolveWorkerFile(): string {
  // `here` is this module's dir (`src/handlers` → `dist/handlers` once built);
  // the worker runner lives one level up under `worker/`.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const jsPath = path.join(here, '..', 'worker', 'runner.js');
  if (existsSync(jsPath)) return jsPath;
  // Running tests via tsx from src/ where .js isn't emitted — fall back to
  // the .ts source. tsx propagates its loader to spawned Workers via
  // NODE_OPTIONS, so this works under `tsx --test`.
  return path.join(here, '..', 'worker', 'runner.ts');
}

const WORKER_FILE = resolveWorkerFile();

export interface RunHandlerOptions {
  app: AppRef;
  handlerFile: string;
  handlerKind: 'query' | 'action';
  args: Record<string, unknown>;
  timeoutMs?: number;
  /**
   * Fired once after an ACTION handler completes successfully. With the
   * per-app silo gone the handler's writes ride ctx.vault, so there is no
   * table-level changeset to enumerate — the notification means "this app
   * acted; re-derive what you render". Query handlers never fire it.
   */
  onWrite?: (tables: string[]) => void;
  /**
   * Host-injected `ctx.vault` executor, already bound to this app's vault
   * identity. When absent, every `ctx.vault.*` call fails closed with
   * `VAULT_UNAVAILABLE` — the worker-side surface always exists, the
   * capability behind it is the host's to mount.
   */
  vault?: VaultBridge;
  /** Overridable for tests; production callers take the shared default (issue #351). */
  admission?: WorkerAdmission;
}

export interface HandlerOutcome {
  ok: boolean;
  value?: unknown;
  error?: string;
  logs: Array<{ level: 'info' | 'warn' | 'error'; msg: string }>;
  /** Set when `ok` is false because admission refused a worker slot (issue #351) — no worker ever spawned. */
  busy?: boolean;
}

/**
 * Runs a user handler in a worker thread. The handler's only data door is
 * `ctx.vault` — a message-passing bridge the host binds to the app's vault
 * credential. No SQLite handle, no file path: the silo is gone (issue
 * #286 phase 2).
 */
export async function runHandler(opts: RunHandlerOptions): Promise<HandlerOutcome> {
  const admission = opts.admission ?? sharedWorkerAdmission;
  // Admission gates the WORKER SPAWN itself (issue #351) — a saturated
  // gateway must fail fast here, before a single extra worker thread comes
  // into existence, not after.
  try {
    await admission.acquire();
  } catch (err) {
    return {
      ok: false,
      busy: true,
      error: err instanceof Error ? err.message : String(err),
      logs: [],
    };
  }
  let released = false;
  const releaseSlot = (): void => {
    if (released) return;
    released = true;
    admission.release();
  };

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

  const handlerName = path.basename(opts.handlerFile).replace(/\.js$/, '');
  const persistedEntries: LogEntry[] = [];

  return await new Promise<HandlerOutcome>((resolve) => {
    let resolved = false;
    const finish = (outcome: HandlerOutcome) => {
      if (resolved) return;
      resolved = true;
      releaseSlot();
      if (timeoutHandle) clearTimeout(timeoutHandle);
      // Notify only on successful action turns — the app acted, views
      // should re-derive. The notifier is wrapped so a thrown listener
      // can't change the handler outcome.
      if (opts.onWrite && opts.handlerKind !== 'query' && outcome.ok) {
        try {
          opts.onWrite([]);
        } catch {
          /* never let notification change the handler outcome */
        }
      }
      worker.removeAllListeners();
      worker.terminate().catch(() => {});
      // Fire-and-forget log persistence — see log-store.ts for the rotation
      // story. Resolving the outcome is independent of the disk write.
      if (persistedEntries.length > 0) {
        void appendLogs(opts.app.dir, persistedEntries);
      }
      // The `resolved` guard above makes this safe across multiple finish() callers
      // eslint-disable-next-line promise/no-multiple-resolved -- grandfathered pre-existing suppression (#247)
      resolve(outcome);
    };

    worker.on('message', (msg: { type: string }) => {
      if (msg.type === 'vault') {
        const call = msg as unknown as {
          id: number;
          op: VaultOp;
          payload: Record<string, unknown>;
        };
        const bridge = opts.vault;
        void (async () => {
          const reply = bridge
            ? await bridge({ op: call.op, payload: call.payload ?? {} }).catch((err: unknown) => ({
                ok: false,
                code: 'VAULT_ERROR',
                error: err instanceof Error ? err.message : String(err),
              }))
            : {
                ok: false,
                code: 'VAULT_UNAVAILABLE',
                error: 'no vault plane is mounted on this gateway',
              };
          // eslint-disable-next-line unicorn/require-post-message-target-origin -- node:worker_threads postMessage has no targetOrigin (#252)
          worker.postMessage({ type: 'vault-reply', id: call.id, ...reply });
        })();
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
