/**
 * Worker entry that executes a user handler (queries / actions).
 *
 * Trust model: app code is **trusted local code** authored by the same user
 * running the gateway (see plugin README). The worker boundary here gives us
 *  - crash isolation (handler exception doesn't take down the plugin)
 *  - timeout enforcement (parent terminates worker on overrun)
 *  - a controlled API surface (db proxy is just message passing)
 *
 * It is NOT a security sandbox against hostile code. Hardening to that level
 * (isolated-vm or child-process + permission flags) is a future swap-in.
 *
 * The db proxy is async — every `db.exec/run/get/all` returns a Promise that
 * resolves when the parent has executed the call against the real sqlite
 * handle. Handlers are expected to `await` their db calls.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

interface WorkerRequest {
  handlerFile: string;
  handlerKind: 'query' | 'action';
  args: unknown;
}

interface DbCallMessage {
  type: 'db';
  id: number;
  method: 'exec' | 'prepare-run' | 'prepare-get' | 'prepare-all' | 'transaction-run';
  payload: unknown;
}

interface DbReplyMessage {
  type: 'db-reply';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface VaultCallMessage {
  type: 'vault';
  id: number;
  op: 'read' | 'search' | 'invoke' | 'query' | 'describe' | 'parked' | 'changes';
  payload: unknown;
}

interface VaultReplyMessage {
  type: 'vault-reply';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
}

interface LogMessage {
  type: 'log';
  level: 'info' | 'warn' | 'error';
  msg: string;
}

interface ResultMessage {
  type: 'result';
  ok: boolean;
  value?: unknown;
  error?: string;
}

if (!parentPort) {
  throw new Error('centraid handler worker must be run as a worker_thread');
}

const port = parentPort;
const req = workerData as WorkerRequest;

let nextDbCallId = 1;
const pendingDbCalls = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

port.on('message', (msg: DbReplyMessage | VaultReplyMessage) => {
  if (msg.type === 'db-reply') {
    const pending = pendingDbCalls.get(msg.id);
    if (!pending) return;
    pendingDbCalls.delete(msg.id);
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new Error(msg.error ?? 'db call failed'));
    return;
  }
  if (msg.type === 'vault-reply') {
    const pending = pendingVaultCalls.get(msg.id);
    if (!pending) return;
    pendingVaultCalls.delete(msg.id);
    if (msg.ok) pending.resolve(msg.result);
    else {
      const err = new Error(msg.error ?? 'vault call failed') as Error & { code?: string };
      if (msg.code) err.code = msg.code;
      pending.reject(err);
    }
  }
});

// ---- ctx.vault — a second RPC channel beside `db`, aimed at the owner's
// personal vault. Same round-trip mechanism, separate id space and message
// type. The parent resolves the running app to its vault credential and
// enforces consent before touching anything; a refusal rejects with the
// receipt id in the message and a machine `code` ('VAULT_CONSENT',
// 'VAULT_UNAVAILABLE', …). No key or file handle ever enters this thread.

let nextVaultCallId = 1;
const pendingVaultCalls = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

function vaultCall(op: VaultCallMessage['op'], payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextVaultCallId++;
    pendingVaultCalls.set(id, { resolve, reject });
    const m: VaultCallMessage = { type: 'vault', id, op, payload };
    port.postMessage(m);
  });
}

const vault = {
  /** Consent-checked read of a canonical entity: `{entity, where?, limit?, purpose}`. */
  read(request: Record<string, unknown>): Promise<unknown> {
    return vaultCall('read', request);
  },
  /**
   * Full-text search over a text-indexed entity:
   * `{entity, query, where?, limit?, purpose}` → ranked `{rows, receiptId}`,
   * each row carrying `_snippet` (matched fragment, hits marked `⟦…⟧`).
   * Matching runs inside the vault's FTS5 index — never read a whole
   * entity to grep it in memory.
   */
  search(request: Record<string, unknown>): Promise<unknown> {
    return vaultCall('search', request);
  },
  /** Typed-command invocation: `{command, input, purpose}` → outcome `{status, output, …}`. */
  invoke(request: Record<string, unknown>): Promise<unknown> {
    return vaultCall('invoke', request);
  },
  /** Query a registered app view, clamped to this app's grants. */
  query(view: string, purpose: string): Promise<unknown> {
    return vaultCall('query', { view, purpose });
  },
  /** Commands discoverable by this app (name, schema, risk, confirmation). */
  describe(): Promise<unknown> {
    return vaultCall('describe', {});
  },
  /**
   * This app's own invocations awaiting owner confirmation — the "my
   * pending approvals" surface (issue #260), so a parked request-booking or
   * send can render as durable state instead of a session-local guess.
   */
  parked(): Promise<unknown> {
    return vaultCall('parked', {});
  },
};

function dbCall(method: DbCallMessage['method'], payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextDbCallId++;
    pendingDbCalls.set(id, { resolve, reject });
    const m: DbCallMessage = { type: 'db', id, method, payload };
    port.postMessage(m);
  });
}

const db = {
  exec(sql: string): Promise<void> {
    return dbCall('exec', { sql }) as Promise<void>;
  },
  prepare(sql: string) {
    return {
      run: (...params: unknown[]) =>
        dbCall('prepare-run', { sql, params }) as Promise<{
          changes: number;
          lastInsertRowid: number | bigint;
        }>,
      get: <T = unknown>(...params: unknown[]) =>
        dbCall('prepare-get', { sql, params }) as Promise<T | undefined>,
      all: <T = unknown>(...params: unknown[]) =>
        dbCall('prepare-all', { sql, params }) as Promise<T[]>,
    };
  },
  transaction<Fn extends (...args: unknown[]) => Promise<unknown>>(fn: Fn): Fn {
    // Each await'd prepare/exec inside fn round-trips to the parent. The
    // parent's sqlite owns the actual transaction boundary via an explicit
    // BEGIN/COMMIT pair invoked here.
    return (async (...args: unknown[]) => {
      await dbCall('transaction-run', { begin: true });
      try {
        const out = await fn(...args);
        await dbCall('transaction-run', { commit: true });
        return out;
      } catch (e) {
        try {
          await dbCall('transaction-run', { rollback: true });
        } catch {
          /* prefer the original error */
        }
        throw e;
      }
    }) as Fn;
  },
};

const log = {
  info: (msg: string) => port.postMessage({ type: 'log', level: 'info', msg } satisfies LogMessage),
  warn: (msg: string) => port.postMessage({ type: 'log', level: 'warn', msg } satisfies LogMessage),
  error: (msg: string) =>
    port.postMessage({ type: 'log', level: 'error', msg } satisfies LogMessage),
};

const abortController = new AbortController();
const ctx = {
  fetch: (input: string, init?: RequestInit) =>
    fetch(input, { ...init, signal: abortController.signal }),
  abortSignal: abortController.signal,
  vault,
};

void (async () => {
  try {
    const mod = (await import(pathToFileURL(req.handlerFile).href)) as {
      default?: (args: unknown) => Promise<unknown>;
    };
    if (typeof mod.default !== 'function') {
      throw new Error(`${req.handlerFile} has no default export`);
    }
    const fullArgs = { ...(req.args as object), db, log, ctx };
    const value = await mod.default(fullArgs);
    port.postMessage({ type: 'result', ok: true, value } satisfies ResultMessage);
  } catch (err) {
    port.postMessage({
      type: 'result',
      ok: false,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    } satisfies ResultMessage);
  } finally {
    abortController.abort();
  }
})();
