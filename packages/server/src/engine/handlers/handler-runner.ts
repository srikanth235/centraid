import { existsSync } from "node:fs";
import path from "node:path";

import { appendLogs } from "../data/log-store.js";
import type { LogEntry } from "../data/log-store.js";
import type { AppRef } from "../types.js";
import type { VaultBridge, VaultOp } from "./vault-bridge.js";
import { sharedWorkerAdmission } from "./worker-admission.js";
import type { WorkerAdmission } from "./worker-admission.js";
import {
  WorkerPool,
  workerPoolSizeFromEnv,
  workerResourceLimitsFromEnv,
} from "./worker-pool.js";

function resolveWorkerFile(): string {
  const here = import.meta.dirname;
  const jsPath = path.join(here, "..", "worker", "runner.js");
  if (existsSync(jsPath)) return jsPath;
  // tsx: no .js from src/; its loader reaches spawned Workers.
  return path.join(here, "..", "worker", "runner.ts");
}

const WORKER_FILE = resolveWorkerFile();

export const HANDLER_WORKER_FILE = WORKER_FILE;

/** Lazy — import must not spawn threads (#404). */
let sharedWorkerPoolInstance: WorkerPool | undefined;
function sharedWorkerPool(): WorkerPool {
  if (!sharedWorkerPoolInstance) {
    sharedWorkerPoolInstance = new WorkerPool(
      WORKER_FILE,
      workerPoolSizeFromEnv(),
      workerResourceLimitsFromEnv()
    );
    sharedWorkerPoolInstance.prewarm();
  }
  return sharedWorkerPoolInstance;
}

export interface RunHandlerOptions {
  app: AppRef;
  handlerFile: string;
  handlerKind: "query" | "action";
  args: Record<string, unknown>;
  timeoutMs?: number;
  /** ACTION turns only, on success. */
  onWrite?: (tables: string[]) => void;
  /** Absent ⇒ `ctx.vault.*` fails closed: `VAULT_UNAVAILABLE`. */
  vault?: VaultBridge;
  /** Host-mounted; this layer must not depend on a runtime host. */
  timeModuleUrl?: string;
  admission?: WorkerAdmission;
  pool?: WorkerPool;
}

export interface HandlerOutcome {
  ok: boolean;
  value?: unknown;
  error?: string;
  logs: Array<{ level: "info" | "warn" | "error"; msg: string }>;
  busy?: boolean;
}

export async function runHandler(
  opts: RunHandlerOptions
): Promise<HandlerOutcome> {
  const admission = opts.admission ?? sharedWorkerAdmission();
  // Gate the spawn (#351): fail before another thread exists.
  try {
    await admission.acquire();
  } catch (error) {
    return {
      ok: false,
      busy: true,
      error: error instanceof Error ? error.message : String(error),
      logs: [],
    };
  }
  let released = false;
  const releaseSlot = (): void => {
    if (released) return;
    released = true;
    admission.release();
  };

  const logs: HandlerOutcome["logs"] = [];

  const pool = opts.pool ?? sharedWorkerPool();
  const worker = pool.acquire();
  const runMessage = {
    type: "run",
    request: {
      handlerFile: opts.handlerFile,
      handlerKind: opts.handlerKind,
      args: { ...opts.args, app: { id: opts.app.id, dir: opts.app.dir } },
      ...(opts.timeModuleUrl ? { timeModuleUrl: opts.timeModuleUrl } : {}),
    },
  };
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- node:worker_threads postMessage has no targetOrigin (#252)
  worker.postMessage(runMessage);

  const handlerName = path
    .basename(opts.handlerFile)
    .replace(/\.(?:ts|js)$/u, "");
  const persistedEntries: LogEntry[] = [];

  return await new Promise<HandlerOutcome>((resolve) => {
    let resolved = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const finish = (outcome: HandlerOutcome) => {
      if (resolved) return;
      resolved = true;
      releaseSlot();
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (opts.onWrite && opts.handlerKind !== "query" && outcome.ok) {
        try {
          opts.onWrite([]);
        } catch {
          /* must not change the outcome */
        }
      }
      worker.removeAllListeners();
      worker.terminate().catch(() => {});
      if (persistedEntries.length > 0) {
        void appendLogs(opts.app.dir, persistedEntries);
      }
      // oxlint-disable-next-line promise/no-multiple-resolved -- grandfathered pre-existing suppression (#247)
      resolve(outcome);
    };

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        const error = `worker timed out after ${opts.timeoutMs}ms`;
        persistedEntries.push({
          ts: Date.now(),
          level: "error",
          msg: error,
          source: opts.handlerKind,
          handler: handlerName,
        });
        finish({ ok: false, error, logs });
      }, opts.timeoutMs);
    }

    worker.on("message", (msg: { type: string }) => {
      if (msg.type === "vault") {
        const call = msg as unknown as {
          id: number;
          op: VaultOp;
          payload: Record<string, unknown>;
        };
        const bridge = opts.vault;
        void (async () => {
          const reply = bridge
            ? await bridge({ op: call.op, payload: call.payload ?? {} }).catch(
                (error: unknown) => ({
                  ok: false,
                  code: "VAULT_ERROR",
                  error: error instanceof Error ? error.message : String(error),
                })
              )
            : {
                ok: false,
                code: "VAULT_UNAVAILABLE",
                error: "no vault plane is mounted on this gateway",
              };
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- node:worker_threads postMessage has no targetOrigin (#252)
          worker.postMessage({ type: "vault-reply", id: call.id, ...reply });
        })();
      } else if (msg.type === "log") {
        const m = msg as unknown as {
          level: "info" | "warn" | "error";
          msg: string;
        };
        logs.push({ level: m.level, msg: m.msg });
        persistedEntries.push({
          ts: Date.now(),
          level: m.level,
          msg: m.msg,
          source: opts.handlerKind,
          handler: handlerName,
        });
      } else if (msg.type === "result") {
        const r = msg as unknown as {
          ok: boolean;
          value?: unknown;
          error?: string;
        };
        if (!r.ok && r.error) {
          persistedEntries.push({
            ts: Date.now(),
            level: "error",
            msg: `${opts.handlerKind} handler failed: ${r.error}`,
            source: opts.handlerKind,
            handler: handlerName,
          });
        }
        finish({ ok: r.ok, value: r.value, error: r.error, logs });
      }
    });
    worker.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      persistedEntries.push({
        ts: Date.now(),
        level: "error",
        msg: `worker error: ${message}`,
        source: opts.handlerKind,
        handler: handlerName,
      });
      finish({ ok: false, error: message, logs });
    });
    worker.on("exit", (code) => {
      if (code !== 0) {
        persistedEntries.push({
          ts: Date.now(),
          level: "error",
          msg: `worker exited with code ${code}`,
          source: opts.handlerKind,
          handler: handlerName,
        });
        finish({ ok: false, error: `worker exited with code ${code}`, logs });
      }
    });
  });
}
