/**
 * Worker entry that executes an *automation* handler.
 *
 * Issue #91: an automation is a standalone app, so the handler arg
 * is `{ automation, log, ctx }` — there is no app `db`. `ctx` exposes
 * `agent` / `fetch` / `state` / `runs` / `vault`. The runner forwards each
 * call back to the parent via message-passing and awaits the matching reply.
 *
 * Two rails, one honest cost story:
 *   - `ctx.agent` is the ONLY billed path — a bounded model turn against the
 *     user's real provider, driven through the runner registry (ACP).
 *   - everything else (`ctx.vault`, `ctx.fetch`, `ctx.state`, `ctx.runs`) is
 *     deterministic, in-process work the parent services directly against
 *     SQLite / the vault bridge. A fire whose handler never calls `ctx.agent`
 *     starts zero child processes and zero HTTP servers.
 *
 * There is no runtime retry: a failed `ctx.*` call rejects the handler's
 * Promise, and the handler (plain JS) owns retry / backoff / error
 * classification via `try/catch`. Each call is an ordering barrier — it
 * flushes to the parent and awaits its reply before the next line runs.
 *
 * Trust model: same as `runner.ts`. App code is trusted; the worker is
 * for crash + timeout isolation, not security sandboxing.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

interface WorkerRequest {
  handlerFile: string;
  args: unknown;
  /** Fire-start instant fixed by the parent; stable for the whole run. */
  now: string;
  /** The payload this run was invoked with — surfaced as `ctx.input`. */
  input?: unknown;
}

type ParentMessage =
  | { type: 'agent-reply'; id: number; ok: boolean; result?: unknown; error?: string }
  | { type: 'state-reply'; id: number; ok: boolean; result?: unknown; error?: string }
  | { type: 'runs-reply'; id: number; ok: boolean; result?: unknown; error?: string }
  | { type: 'fetch-reply'; id: number; ok: boolean; result?: unknown; error?: string }
  | {
      type: 'vault-reply';
      id: number;
      ok: boolean;
      result?: unknown;
      error?: string;
      code?: string;
    }
  | { type: 'abort'; reason?: string }
  | { type: 'run'; request: WorkerRequest };

/**
 * A `ctx.fetch` request (issue #293 decision 8, connector-only). Any string
 * may carry `{{secret:locker:<item_id>:<column>}}` placeholders — the PARENT
 * resolves them after the message leaves this worker, so plaintext secrets
 * never enter handler memory and cannot be logged from here.
 */
export interface FetchSpec {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

type WorkerMessage =
  | {
      type: 'agent';
      id: number;
      prompt: string;
      json?: unknown;
      content?: { contentId: string; variant: string; maxBytes?: number }[];
    }
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
      op:
        | 'read'
        | 'search'
        | 'invoke'
        | 'query'
        | 'describe'
        | 'parked'
        | 'changes'
        | 'resolve'
        | 'reveal'
        | 'content';
      payload: Record<string, unknown>;
    }
  | { type: 'fetch'; id: number; spec: FetchSpec }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; msg: string }
  | { type: 'result'; ok: boolean; value?: unknown; error?: string };

if (!parentPort) {
  throw new Error('centraid automation worker must be run as a worker_thread');
}
const port = parentPort;
const boot = workerData as { pooled?: boolean } & Partial<WorkerRequest>;
let req = boot as WorkerRequest;

let nextCallId = 1;
// One id space, one pending map for every request/reply lane. The reply type
// discriminates on the wire; the promise doesn't care which lane it rode.
const pendingCalls = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

/** Omit that distributes over a union instead of collapsing it to common keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RpcRequest = DistributiveOmit<
  Exclude<WorkerMessage, { type: 'log' } | { type: 'result' }>,
  'id'
>;

/** Post one request message and await its `*-reply`. Each ctx.* call is an
 *  ordering barrier — the handler awaits the reply before its next line. */
function rpcCall(msg: RpcRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextCallId++;
    pendingCalls.set(id, { resolve, reject });
    port.postMessage({ ...msg, id } as WorkerMessage);
  });
}

const abortController = new AbortController();

function rejectAllPending(reason: string): void {
  const err = new Error(reason);
  for (const [, p] of pendingCalls) p.reject(err);
  pendingCalls.clear();
}

port.on('message', (msg: ParentMessage) => {
  if (msg.type === 'run') {
    execute(msg.request);
    return;
  }
  if (
    msg.type === 'agent-reply' ||
    msg.type === 'state-reply' ||
    msg.type === 'runs-reply' ||
    msg.type === 'fetch-reply' ||
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
  op:
    | 'read'
    | 'search'
    | 'invoke'
    | 'query'
    | 'describe'
    | 'parked'
    | 'changes'
    | 'resolve'
    | 'reveal'
    | 'content',
  payload: Record<string, unknown>,
): Promise<unknown> {
  return rpcCall({ type: 'vault', op, payload });
}

const vault = {
  read(request: Record<string, unknown>): Promise<unknown> {
    return vaultCall('read', request);
  },
  /** FTS5 search over a text-indexed entity — match vault-side, never grep a full read. */
  search(request: Record<string, unknown>): Promise<unknown> {
    return vaultCall('search', request);
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
  /** Reference cards for cross-domain (type, id) refs (issue #272). */
  resolve(request: Record<string, unknown>): Promise<unknown> {
    return vaultCall('resolve', request);
  },
  /** Plaintext of one entity's sealed columns — `reveal` verb, receipted per item (issue #293). */
  reveal(request: Record<string, unknown>): Promise<unknown> {
    return vaultCall('reveal', request);
  },
  /**
   * One content item's derivative, size-bounded (issue #299): `variant` is
   * `thumb`, `preview` or `text` — originals never egress. Every fetch is a
   * receipted read on the host side.
   */
  content(request: Record<string, unknown>): Promise<unknown> {
    return vaultCall('content', request);
  },
};

const ctx = {
  /** ISO fire-start instant: current enough for leases, deterministic on replay. */
  now: req.now,
  /**
   * Transport-level HTTP for connectors (issue #293): strings may reference
   * declared secrets as `{{secret:locker:<item_id>:<column>}}` — the host
   * substitutes and performs the request; the secret never enters this
   * worker. Non-connector runs are refused host-side.
   */
  fetch(
    spec: FetchSpec,
  ): Promise<{ status: number; headers: Record<string, string>; text: string }> {
    return rpcCall({ type: 'fetch', spec }) as Promise<{
      status: number;
      headers: Record<string, string>;
      text: string;
    }>;
  },
  /**
   * One bounded model turn — the ONLY billed rail. `content` names vault
   * derivatives (thumb / preview / text of a content item) to hand the model
   * alongside the prompt — the HOST resolves them under this automation's
   * grant, receipts each fetch, and stages the bytes for the provider; the
   * worker never holds them (issue #299 §2).
   */
  agent(args: {
    prompt: string;
    json?: unknown;
    content?: { contentId: string; variant: string; maxBytes?: number }[];
  }): Promise<unknown> {
    return rpcCall({
      type: 'agent',
      prompt: args.prompt,
      ...(args.json !== undefined ? { json: args.json } : {}),
      ...(args.content !== undefined ? { content: args.content } : {}),
    });
  },
  state,
  runs,
  vault,
  input: req.input,
  abortSignal: abortController.signal,
};

function execute(request: WorkerRequest): void {
  req = request;
  ctx.now = request.now;
  ctx.input = request.input;
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
}

if (boot.pooled) port.postMessage({ type: 'ready' });
else execute(boot as WorkerRequest);
