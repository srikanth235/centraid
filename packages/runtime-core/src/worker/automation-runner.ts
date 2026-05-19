/**
 * Worker entry that executes an *automation* handler.
 *
 * Parallel to `runner.ts` (which executes queries / actions). The shape
 * of the handler arg differs: queries/actions get `{ db, log, app, ctx:
 * { fetch, abortSignal } }`, automations get `{ db, log, app, ctx: {
 * tool, agent, abortSignal } }`. The runner forwards `tool` and `agent`
 * calls back to the parent via message-passing — the same idiom as the
 * db proxy, but with a notable extension: per-microtask **batching**.
 *
 * Why batching: each batch dispatches to one host agent turn (one
 * `codex exec` / `claude -p` spawn on local, one `createStreamFn`
 * invocation on remote). Spawning a CLI subprocess costs 1–3s of cold
 * start; if a handler did `for (const x of xs) await ctx.tool(...)`,
 * 50 sequential calls = 50 spawns = 50–150 s of overhead.
 *
 * Mitigation: when the handler does `Promise.all([ctx.tool(a),
 * ctx.tool(b), ctx.tool(c)])`, we collect all three queued tool calls
 * inside the same microtask checkpoint and dispatch them as ONE batch
 * to the parent. The parent stages them as one mock-LLM turn returning
 * three `tool_use` blocks, the host CLI executes all three through its
 * MCP pipeline in one shot, and the three Promises resolve together.
 *
 * `ctx.agent` is fundamentally a different turn shape (constrained
 * inference, not tool dispatch) so it never batches with `ctx.tool` —
 * it flushes pending tool batches first, then runs as its own one-shot
 * agent turn.
 *
 * Trust model: same as `runner.ts`. App code is trusted; the worker is
 * for crash + timeout isolation, not security sandboxing.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

interface WorkerRequest {
  handlerFile: string;
  args: unknown;
}

type ParentMessage =
  | { type: 'db-reply'; id: number; ok: boolean; result?: unknown; error?: string }
  | {
      type: 'tool-reply';
      id: number;
      results: Array<{ ok: boolean; result?: unknown; error?: string }>;
    }
  | { type: 'agent-reply'; id: number; ok: boolean; result?: unknown; error?: string }
  | { type: 'abort'; reason?: string };

type WorkerMessage =
  | { type: 'db'; id: number; method: string; payload: unknown }
  | { type: 'tool-batch'; id: number; calls: Array<{ name: string; args: unknown }> }
  | { type: 'agent'; id: number; prompt: string; json?: unknown }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; msg: string }
  | { type: 'result'; ok: boolean; value?: unknown; error?: string };

if (!parentPort) {
  throw new Error('centraid automation worker must be run as a worker_thread');
}
const port = parentPort;
const req = workerData as WorkerRequest;

// --- shared bookkeeping ---------------------------------------------------

let nextCallId = 1;
const pendingDb = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const pendingAgent = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

interface PendingToolCall {
  name: string;
  args: unknown;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

// A "batch" is the set of `ctx.tool` calls that were queued before the
// next microtask boundary drained. The flush is scheduled with
// `queueMicrotask` so that synchronous `ctx.tool(...).ctx.tool(...)`
// chains (and `Promise.all([...])` siblings) end up in the same batch.
let pendingToolBatch: PendingToolCall[] = [];
const pendingToolBatchById = new Map<
  number,
  {
    calls: PendingToolCall[];
  }
>();
let batchScheduled = false;

function flushBatch(): void {
  batchScheduled = false;
  if (pendingToolBatch.length === 0) return;
  const id = nextCallId++;
  const calls = pendingToolBatch;
  pendingToolBatch = [];
  pendingToolBatchById.set(id, { calls });
  const msg: WorkerMessage = {
    type: 'tool-batch',
    id,
    calls: calls.map((c) => ({ name: c.name, args: c.args })),
  };
  port.postMessage(msg);
}

function scheduleBatchFlush(): void {
  if (batchScheduled) return;
  batchScheduled = true;
  queueMicrotask(flushBatch);
}

// --- abort plumbing -------------------------------------------------------

const abortController = new AbortController();

function rejectAllPending(reason: string): void {
  for (const [, p] of pendingDb) p.reject(new Error(reason));
  pendingDb.clear();
  for (const [, p] of pendingAgent) p.reject(new Error(reason));
  pendingAgent.clear();
  for (const call of pendingToolBatch) call.reject(new Error(reason));
  pendingToolBatch = [];
  for (const [, batch] of pendingToolBatchById) {
    for (const c of batch.calls) c.reject(new Error(reason));
  }
  pendingToolBatchById.clear();
}

// --- parent message router ------------------------------------------------

port.on('message', (msg: ParentMessage) => {
  if (msg.type === 'db-reply') {
    const p = pendingDb.get(msg.id);
    if (!p) return;
    pendingDb.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? 'db call failed'));
    return;
  }
  if (msg.type === 'tool-reply') {
    const batch = pendingToolBatchById.get(msg.id);
    if (!batch) return;
    pendingToolBatchById.delete(msg.id);
    if (batch.calls.length !== msg.results.length) {
      // Shouldn't happen — parent always returns one result per call.
      for (const c of batch.calls) {
        c.reject(new Error('tool-reply length mismatch'));
      }
      return;
    }
    for (let i = 0; i < batch.calls.length; i++) {
      const result = msg.results[i]!;
      const call = batch.calls[i]!;
      if (result.ok) call.resolve(result.result);
      else call.reject(new Error(result.error ?? `tool ${call.name} failed`));
    }
    return;
  }
  if (msg.type === 'agent-reply') {
    const p = pendingAgent.get(msg.id);
    if (!p) return;
    pendingAgent.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? 'agent call failed'));
    return;
  }
  if (msg.type === 'abort') {
    abortController.abort(msg.reason ?? 'aborted');
    rejectAllPending(msg.reason ?? 'aborted');
  }
});

// --- ctx surface ----------------------------------------------------------

function dbCall(method: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextCallId++;
    pendingDb.set(id, { resolve, reject });
    port.postMessage({ type: 'db', id, method, payload } satisfies WorkerMessage);
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
  info: (msg: string) =>
    port.postMessage({ type: 'log', level: 'info', msg } satisfies WorkerMessage),
  warn: (msg: string) =>
    port.postMessage({ type: 'log', level: 'warn', msg } satisfies WorkerMessage),
  error: (msg: string) =>
    port.postMessage({ type: 'log', level: 'error', msg } satisfies WorkerMessage),
};

const ctx = {
  tool(name: string, args: unknown): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      pendingToolBatch.push({ name, args, resolve, reject });
      scheduleBatchFlush();
    });
  },
  agent(args: { prompt: string; json?: unknown }): Promise<unknown> {
    // Flush any pending tool batch first — keeps inference well-defined
    // relative to side-effecting tool dispatches that preceded it.
    if (pendingToolBatch.length > 0) flushBatch();
    return new Promise((resolve, reject) => {
      const id = nextCallId++;
      pendingAgent.set(id, { resolve, reject });
      const msg: WorkerMessage = {
        type: 'agent',
        id,
        prompt: args.prompt,
        ...(args.json !== undefined ? { json: args.json } : {}),
      };
      port.postMessage(msg);
    });
  },
  abortSignal: abortController.signal,
};

// --- handler invocation ---------------------------------------------------

(async () => {
  try {
    const mod = (await import(pathToFileURL(req.handlerFile).href)) as {
      default?: (args: unknown) => Promise<unknown>;
    };
    if (typeof mod.default !== 'function') {
      throw new Error(`${req.handlerFile} has no default export`);
    }
    const fullArgs = { ...(req.args as object), db, log, ctx };
    const value = await mod.default(fullArgs);
    port.postMessage({ type: 'result', ok: true, value } satisfies WorkerMessage);
  } catch (err) {
    port.postMessage({
      type: 'result',
      ok: false,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    } satisfies WorkerMessage);
  } finally {
    abortController.abort();
  }
})();
