/**
 * Worker entry that executes an *automation* handler.
 *
 * Issue #91: an automation is a standalone project, so the handler arg
 * is `{ automation, log, ctx }` — there is no app `db`. `ctx` exposes
 * `tool` / `agent` / `state` / `runs` / `invoke`. The runner forwards
 * `tool` and `agent` calls back to the parent via message-passing, with
 * per-microtask **batching** for `ctx.tool`.
 *
 * Why batching: each batch dispatches to one host agent turn (one
 * `codex exec` / `claude -p` spawn on local). Spawning a CLI subprocess
 * costs 1–3s of cold start; if a handler did `for (const x of xs) await
 * ctx.tool(...)`, 50 sequential calls = 50 spawns = 50–150 s of
 * overhead.
 *
 * Mitigation: when the handler does `Promise.all([ctx.tool(a),
 * ctx.tool(b), ctx.tool(c)])`, we collect all three queued tool calls
 * inside the same microtask checkpoint and dispatch them as ONE batch
 * to the parent.
 *
 * There is no runtime retry: a failed `ctx.tool` rejects the handler's
 * Promise, and the handler (plain JS) owns retry / backoff / error
 * classification via `try/catch`.
 *
 * `ctx.agent`, `ctx.state.*`, `ctx.runs.*`, and `ctx.invoke` are
 * fundamentally different turn shapes so they never batch with
 * `ctx.tool` — each flushes any pending tool batch first, then runs as
 * its own one-shot turn.
 *
 * Trust model: same as `runner.ts`. App code is trusted; the worker is
 * for crash + timeout isolation, not security sandboxing.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

interface WorkerRequest {
  handlerFile: string;
  args: unknown;
  /** The payload this run was invoked with — surfaced as `ctx.input`. */
  input?: unknown;
}

interface ToolCallWire {
  name: string;
  args: unknown;
}

type ParentMessage =
  | {
      type: 'tool-reply';
      id: number;
      results: Array<{ ok: boolean; result?: unknown; error?: string }>;
    }
  | { type: 'agent-reply'; id: number; ok: boolean; result?: unknown; error?: string }
  | { type: 'state-reply'; id: number; ok: boolean; result?: unknown; error?: string }
  | { type: 'runs-reply'; id: number; ok: boolean; result?: unknown; error?: string }
  | { type: 'invoke-reply'; id: number; ok: boolean; result?: unknown; error?: string }
  | { type: 'abort'; reason?: string };

type WorkerMessage =
  | { type: 'tool-batch'; id: number; calls: ToolCallWire[] }
  | { type: 'agent'; id: number; prompt: string; json?: unknown }
  | { type: 'state'; id: number; method: 'get' | 'set' | 'delete'; key: string; value?: unknown }
  | {
      type: 'runs';
      id: number;
      method: 'last' | 'list';
      filter: { automationId?: string; status?: 'ok' | 'error'; since?: number; limit?: number };
    }
  | { type: 'invoke'; id: number; name: string; input?: unknown }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; msg: string }
  | { type: 'result'; ok: boolean; value?: unknown; error?: string };

if (!parentPort) {
  throw new Error('centraid automation worker must be run as a worker_thread');
}
const port = parentPort;
const req = workerData as WorkerRequest;

let nextCallId = 1;
const pendingAgent = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
const pendingState = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
const pendingRuns = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
const pendingInvoke = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

interface PendingToolCall {
  name: string;
  args: unknown;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

let pendingToolBatch: PendingToolCall[] = [];
const pendingToolBatchById = new Map<number, { calls: PendingToolCall[] }>();
let batchScheduled = false;

function flushBatch(): void {
  batchScheduled = false;
  if (pendingToolBatch.length === 0) return;
  const id = nextCallId++;
  const calls = pendingToolBatch;
  pendingToolBatch = [];
  pendingToolBatchById.set(id, { calls });
  const wire: ToolCallWire[] = calls.map((c) => ({ name: c.name, args: c.args }));
  port.postMessage({ type: 'tool-batch', id, calls: wire } satisfies WorkerMessage);
}

function scheduleBatchFlush(): void {
  if (batchScheduled) return;
  batchScheduled = true;
  queueMicrotask(flushBatch);
}

const abortController = new AbortController();

function rejectAllPending(reason: string): void {
  const err = new Error(reason);
  for (const [, p] of pendingAgent) p.reject(err);
  pendingAgent.clear();
  for (const [, p] of pendingState) p.reject(err);
  pendingState.clear();
  for (const [, p] of pendingRuns) p.reject(err);
  pendingRuns.clear();
  for (const [, p] of pendingInvoke) p.reject(err);
  pendingInvoke.clear();
  for (const call of pendingToolBatch) call.reject(err);
  pendingToolBatch = [];
  for (const [, batch] of pendingToolBatchById) {
    for (const c of batch.calls) c.reject(err);
  }
  pendingToolBatchById.clear();
}

port.on('message', (msg: ParentMessage) => {
  if (msg.type === 'tool-reply') {
    const batch = pendingToolBatchById.get(msg.id);
    if (!batch) return;
    pendingToolBatchById.delete(msg.id);
    if (batch.calls.length !== msg.results.length) {
      for (const c of batch.calls) c.reject(new Error('tool-reply length mismatch'));
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
  if (msg.type === 'state-reply') {
    const p = pendingState.get(msg.id);
    if (!p) return;
    pendingState.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? 'state call failed'));
    return;
  }
  if (msg.type === 'runs-reply') {
    const p = pendingRuns.get(msg.id);
    if (!p) return;
    pendingRuns.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? 'runs query failed'));
    return;
  }
  if (msg.type === 'invoke-reply') {
    const p = pendingInvoke.get(msg.id);
    if (!p) return;
    pendingInvoke.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? 'invoke failed'));
    return;
  }
  if (msg.type === 'abort') {
    abortController.abort(msg.reason ?? 'aborted');
    rejectAllPending(msg.reason ?? 'aborted');
  }
});

const log = {
  info: (msg: string) =>
    port.postMessage({ type: 'log', level: 'info', msg } satisfies WorkerMessage),
  warn: (msg: string) =>
    port.postMessage({ type: 'log', level: 'warn', msg } satisfies WorkerMessage),
  error: (msg: string) =>
    port.postMessage({ type: 'log', level: 'error', msg } satisfies WorkerMessage),
};

function flushPendingToolBatchIfAny(): void {
  if (pendingToolBatch.length > 0) flushBatch();
}

const state = {
  get<T = unknown>(key: string): Promise<T | undefined> {
    flushPendingToolBatchIfAny();
    return new Promise<unknown>((resolve, reject) => {
      const id = nextCallId++;
      pendingState.set(id, { resolve, reject });
      port.postMessage({ type: 'state', id, method: 'get', key } satisfies WorkerMessage);
    }) as Promise<T | undefined>;
  },
  set(key: string, value: unknown): Promise<void> {
    flushPendingToolBatchIfAny();
    return new Promise((resolve, reject) => {
      const id = nextCallId++;
      pendingState.set(id, { resolve: () => resolve(), reject });
      port.postMessage({ type: 'state', id, method: 'set', key, value } satisfies WorkerMessage);
    });
  },
  delete(key: string): Promise<void> {
    flushPendingToolBatchIfAny();
    return new Promise((resolve, reject) => {
      const id = nextCallId++;
      pendingState.set(id, { resolve: () => resolve(), reject });
      port.postMessage({ type: 'state', id, method: 'delete', key } satisfies WorkerMessage);
    });
  },
};

const runs = {
  last(filter: { automationId?: string; status?: 'ok' | 'error' } = {}): Promise<unknown> {
    flushPendingToolBatchIfAny();
    return new Promise((resolve, reject) => {
      const id = nextCallId++;
      pendingRuns.set(id, { resolve, reject });
      port.postMessage({ type: 'runs', id, method: 'last', filter } satisfies WorkerMessage);
    });
  },
  list(
    filter: {
      automationId?: string;
      status?: 'ok' | 'error';
      since?: number;
      limit?: number;
    } = {},
  ): Promise<unknown> {
    flushPendingToolBatchIfAny();
    return new Promise((resolve, reject) => {
      const id = nextCallId++;
      pendingRuns.set(id, { resolve, reject });
      port.postMessage({ type: 'runs', id, method: 'list', filter } satisfies WorkerMessage);
    });
  },
};

const ctx = {
  tool(name: string, args: unknown): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      pendingToolBatch.push({ name, args, resolve, reject });
      scheduleBatchFlush();
    });
  },
  agent(args: { prompt: string; json?: unknown }): Promise<unknown> {
    flushPendingToolBatchIfAny();
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
  state,
  runs,
  input: req.input,
  invoke(name: string, args: { input?: unknown } = {}): Promise<unknown> {
    flushPendingToolBatchIfAny();
    return new Promise((resolve, reject) => {
      const id = nextCallId++;
      pendingInvoke.set(id, { resolve, reject });
      const msg: WorkerMessage = {
        type: 'invoke',
        id,
        name,
        ...(args.input !== undefined ? { input: args.input } : {}),
      };
      port.postMessage(msg);
    });
  },
  abortSignal: abortController.signal,
};

(async () => {
  try {
    const mod = (await import(pathToFileURL(req.handlerFile).href)) as {
      default?: (args: unknown) => Promise<unknown>;
    };
    if (typeof mod.default !== 'function') {
      throw new Error(`${req.handlerFile} has no default export`);
    }
    const fullArgs = { ...(req.args as object), log, ctx };
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
