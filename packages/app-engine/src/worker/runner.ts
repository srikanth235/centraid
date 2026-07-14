/**
 * Worker entry that executes a user handler (queries / actions).
 *
 * Trust model: app code is **trusted local code** authored by the same user
 * running the gateway (see plugin README). The worker boundary here gives us
 *  - crash isolation (handler exception doesn't take down the plugin)
 *  - timeout enforcement (parent terminates worker on overrun)
 *  - a controlled API surface (ctx.vault is just message passing)
 *
 * It is NOT a security sandbox against hostile code. Hardening to that level
 * (isolated-vm or child-process + permission flags) is a future swap-in.
 *
 * The handler's only data door is `ctx.vault` (issue #286 phase 2: apps are
 * projections over the owner's vault — the per-app data.sqlite is gone).
 * Every call is async message passing to the parent, which holds the
 * credential and enforces consent.
 *
 * Warm-spare pooling (issue #404): a worker runs EXACTLY ONE handler and is
 * then discarded — the parent never reuses a worker across handler runs, so a
 * handler always executes in a thread whose module registry has imported no
 * other handler (isolation identical to the spawn-per-run model). Two boot
 * shapes:
 *  - **inline** — `workerData` carries `{ handlerFile, handlerKind, args }`;
 *    the worker imports and runs immediately (legacy path, still used by any
 *    direct caller / test).
 *  - **pooled** — `workerData` is `{ pooled: true }`; the worker finishes
 *    booting (thread start + this module's evaluation — the cost the pool
 *    pays ahead of time), posts `{ type: 'ready' }`, then waits for a single
 *    `{ type: 'run', request }` message carrying the handler to execute. The
 *    warmth win is that the expensive boot happens on a spare thread while a
 *    previous request runs, off the acquiring request's critical path.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

interface WorkerRequest {
  handlerFile: string;
  handlerKind: 'query' | 'action';
  args: unknown;
}

/** Parent → pooled-worker kickoff carrying the handler to run. */
interface RunMessage {
  type: 'run';
  request: WorkerRequest;
}

interface VaultCallMessage {
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
    | 'reveal';
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
const boot = workerData as { pooled?: boolean } & Partial<WorkerRequest>;

port.on('message', (msg: VaultReplyMessage | RunMessage) => {
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
  } else if (msg.type === 'run') {
    // Pooled kickoff — exactly one per worker (single-use, see header).
    execute(msg.request);
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
  /**
   * The card resolver (issue #272): `{refs: [{type, id}], purpose}` →
   * `{cards, receiptId}` — minimal renderable cards for cross-domain
   * references, resolvable when a live core.link connects them to something
   * this caller reads. Denials arrive as per-ref `status: 'denied'` cards.
   */
  resolve(request: Record<string, unknown>): Promise<unknown> {
    return vaultCall('resolve', request);
  },
  /** Plaintext of one entity's sealed columns — `reveal` verb, receipted per item (issue #293). */
  reveal(request: Record<string, unknown>): Promise<unknown> {
    return vaultCall('reveal', request);
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

function execute(req: WorkerRequest): void {
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
}

if (boot.pooled) {
  // Warm spare: booted and idle. Announce readiness (the parent ignores this
  // until it hands over a run), then wait for the single `run` kickoff above.
  port.postMessage({ type: 'ready' });
} else {
  // Inline boot: the request rode in on workerData — run it now.
  execute(boot as WorkerRequest);
}
