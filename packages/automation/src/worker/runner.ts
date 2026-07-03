/**
 * Worker entry that executes an *automation* handler.
 *
 * Issue #91: an automation is a standalone app, so the handler arg
 * is `{ automation, log, ctx }` — there is no app `db`. `ctx` exposes
 * `tool` / `agent` / `state` / `runs`. The runner forwards
 * `tool` and `agent` calls back to the parent via message-passing, with
 * per-microtask **batching** for `ctx.tool`.
 *
 * Why batching: each batch dispatches to one host agent turn (a mock
 * round-trip through the persistent session — an in-process Claude SDK turn
 * or a `codex exec` subprocess on local). Each turn carries latency; if a
 * handler did `for (const x of xs) await ctx.tool(...)`, 50 sequential calls
 * = 50 turns = 50 round-trips of overhead.
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
 * `ctx.agent`, `ctx.state.*`, and `ctx.runs.*` are fundamentally
 * different turn shapes so they never batch with `ctx.tool` — each
 * flushes any pending tool batch first, then runs as its own one-shot
 * turn.
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
  | {
      type: 'vault-reply';
      id: number;
      ok: boolean;
      result?: unknown;
      error?: string;
      code?: string;
    }
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
  | {
      type: 'vault';
      id: number;
      op: 'read' | 'invoke' | 'query' | 'describe' | 'parked' | 'changes';
      payload: Record<string, unknown>;
    }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; msg: string }
  | { type: 'result'; ok: boolean; value?: unknown; error?: string };

if (!parentPort) {
  throw new Error('centraid automation worker must be run as a worker_thread');
}
const port = parentPort;
const req = workerData as WorkerRequest;

let nextCallId = 1;
// One id space, one pending map for every request/reply lane except tool
// batches (which settle per-call, below). The reply type discriminates on
// the wire; the promise doesn't care which lane it rode.
const pendingCalls = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

/** Omit that distributes over a union instead of collapsing it to common keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RpcRequest = DistributiveOmit<
  Exclude<WorkerMessage, { type: 'tool-batch' } | { type: 'log' } | { type: 'result' }>,
  'id'
>;

/** Post one request message and await its `*-reply`. Flushes tools first —
 *  agent/state/runs/vault calls are ordering barriers for the tool batch. */
function rpcCall(msg: RpcRequest): Promise<unknown> {
  flushPendingToolBatchIfAny();
  return new Promise((resolve, reject) => {
    const id = nextCallId++;
    pendingCalls.set(id, { resolve, reject });
    port.postMessage({ ...msg, id } as WorkerMessage);
  });
}

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
  for (const [, p] of pendingCalls) p.reject(err);
  pendingCalls.clear();
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
  if (
    msg.type === 'agent-reply' ||
    msg.type === 'state-reply' ||
    msg.type === 'runs-reply' ||
    msg.type === 'vault-reply'
  ) {
    const p = pendingCalls.get(msg.id);
    if (!p) return;
    pendingCalls.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else {
      const err = new Error(
        msg.error ?? `${msg.type.replace('-reply', '')} call failed`,
      ) as Error & {
        code?: string;
      };
      if ('code' in msg && msg.code) err.code = msg.code;
      p.reject(err);
    }
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
    return rpcCall({ type: 'state', method: 'get', key }) as Promise<T | undefined>;
  },
  async set(key: string, value: unknown): Promise<void> {
    await rpcCall({ type: 'state', method: 'set', key, value });
  },
  async delete(key: string): Promise<void> {
    await rpcCall({ type: 'state', method: 'delete', key });
  },
};

const runs = {
  last(filter: { automationId?: string; status?: 'ok' | 'error' } = {}): Promise<unknown> {
    return rpcCall({ type: 'runs', method: 'last', filter });
  },
  list(
    filter: {
      automationId?: string;
      status?: 'ok' | 'error';
      since?: number;
      limit?: number;
    } = {},
  ): Promise<unknown> {
    return rpcCall({ type: 'runs', method: 'list', filter });
  },
};

// ctx.vault — a second RPC channel aimed at the owner's personal vault
// (duaility §12). The parent resolves this automation to its enrolled
// `agent.agent` credential host-side; the worker carries capability, never
// a key. Same surface an app handler's `ctx.vault` exposes, plus `parked`
// (this agent's invocations awaiting owner confirmation) and `changes`
// (the consented journal feed data triggers ride).
function vaultCall(
  op: 'read' | 'invoke' | 'query' | 'describe' | 'parked' | 'changes',
  payload: Record<string, unknown>,
): Promise<unknown> {
  return rpcCall({ type: 'vault', op, payload });
}

const vault = {
  read(request: Record<string, unknown>): Promise<unknown> {
    return vaultCall('read', request);
  },
  invoke(request: Record<string, unknown>): Promise<unknown> {
    return vaultCall('invoke', request);
  },
  query(view: string, purpose: string): Promise<unknown> {
    return vaultCall('query', { view, purpose });
  },
  describe(): Promise<unknown> {
    return vaultCall('describe', {});
  },
  parked(): Promise<unknown> {
    return vaultCall('parked', {});
  },
  changes(request: Record<string, unknown>): Promise<unknown> {
    return vaultCall('changes', request);
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
    return rpcCall({
      type: 'agent',
      prompt: args.prompt,
      ...(args.json !== undefined ? { json: args.json } : {}),
    });
  },
  state,
  runs,
  vault,
  input: req.input,
  abortSignal: abortController.signal,
};

void (async () => {
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
