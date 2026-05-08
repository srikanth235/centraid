/**
 * Worker entry that executes a user handler (queries / actions / crons).
 *
 * Trust model: app code is **trusted local code** authored by the same user
 * running the gateway (see plugin README). The worker boundary here gives us
 *  - crash isolation (handler exception doesn't take down the plugin)
 *  - timeout enforcement (parent terminates worker on overrun)
 *  - a controlled API surface (db proxy is just message passing)
 *
 * It is NOT a security sandbox against hostile code. Hardening to that level
 * (isolated-vm or child-process + permission flags) is a future swap-in.
 */

import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

interface WorkerRequest {
  handlerFile: string;
  handlerKind: "query" | "action" | "cron";
  args: unknown;
}

interface DbCallMessage {
  type: "db";
  id: number;
  method: "exec" | "prepare-run" | "prepare-get" | "prepare-all" | "transaction-run";
  payload: unknown;
}

interface DbReplyMessage {
  type: "db-reply";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface LogMessage {
  type: "log";
  level: "info" | "warn" | "error";
  msg: string;
}

interface ResultMessage {
  type: "result";
  ok: boolean;
  value?: unknown;
  error?: string;
}

if (!parentPort) {
  throw new Error("centraid handler worker must be run as a worker_thread");
}

const port = parentPort;
const req = workerData as WorkerRequest;

let nextDbCallId = 1;
const pendingDbCalls = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

port.on("message", (msg: DbReplyMessage) => {
  if (msg.type !== "db-reply") return;
  const pending = pendingDbCalls.get(msg.id);
  if (!pending) return;
  pendingDbCalls.delete(msg.id);
  if (msg.ok) pending.resolve(msg.result);
  else pending.reject(new Error(msg.error ?? "db call failed"));
});

function dbCall(method: DbCallMessage["method"], payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextDbCallId++;
    pendingDbCalls.set(id, { resolve, reject });
    const m: DbCallMessage = { type: "db", id, method, payload };
    port.postMessage(m);
  });
}

const db = {
  exec(sql: string): void {
    void dbCall("exec", { sql });
  },
  prepare(sql: string) {
    return {
      run: async (...params: unknown[]) => dbCall("prepare-run", { sql, params }),
      get: async (...params: unknown[]) => dbCall("prepare-get", { sql, params }),
      all: async (...params: unknown[]) => dbCall("prepare-all", { sql, params }),
    };
  },
  transaction<Fn extends (...args: unknown[]) => unknown>(fn: Fn): Fn {
    // Pass-through; each prepare/exec inside fn round-trips to the parent.
    // The parent's better-sqlite3 owns the actual transaction boundary via
    // an explicit BEGIN/COMMIT pair invoked here.
    return ((...args: unknown[]) => {
      void dbCall("transaction-run", { begin: true });
      try {
        const out = fn(...args);
        void dbCall("transaction-run", { commit: true });
        return out;
      } catch (e) {
        void dbCall("transaction-run", { rollback: true });
        throw e;
      }
    }) as Fn;
  },
};

const log = {
  info: (msg: string) => port.postMessage({ type: "log", level: "info", msg } satisfies LogMessage),
  warn: (msg: string) => port.postMessage({ type: "log", level: "warn", msg } satisfies LogMessage),
  error: (msg: string) =>
    port.postMessage({ type: "log", level: "error", msg } satisfies LogMessage),
};

const abortController = new AbortController();
const ctx = {
  fetch: (input: string, init?: RequestInit) =>
    fetch(input, { ...init, signal: abortController.signal }),
  abortSignal: abortController.signal,
};

(async () => {
  try {
    const mod = (await import(pathToFileURL(req.handlerFile).href)) as {
      default?: (args: unknown) => Promise<unknown>;
    };
    if (typeof mod.default !== "function") {
      throw new Error(`${req.handlerFile} has no default export`);
    }
    const fullArgs = { ...(req.args as object), db, log, ctx };
    const value = await mod.default(fullArgs);
    port.postMessage({ type: "result", ok: true, value } satisfies ResultMessage);
  } catch (err) {
    port.postMessage({
      type: "result",
      ok: false,
      error: err instanceof Error ? err.stack ?? err.message : String(err),
    } satisfies ResultMessage);
  } finally {
    abortController.abort();
  }
})();
