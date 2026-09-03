/**
 * Worker entry that executes app handlers. The app-handler sandbox is
 * installed before the handler graph is imported (#842), so network reach
 * survives only as `ctx.fetch` and the only data door is `ctx.vault`. It is
 * still NOT an OS sandbox — read `../sandbox/install.ts`'s limits before
 * describing this boundary in a threat model.
 *
 * A THREAD SERVES MANY RUNS (#922 B3) and every run gets a fresh handler
 * graph: the handler is imported under a per-run URL, so nothing a handler
 * kept at module scope — a memo, a cursor, a captured `ctx` — is visible to
 * the next run. The sandbox itself is installed ONCE and is one-way, so the
 * pool only ever hands this thread runs in the lane it is already committed
 * to (see `../handlers/worker-pool.ts`).
 */

import { existsSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

async function loadSandboxBoot(): Promise<typeof import("../sandbox/boot.js")> {
  const dir = path.join(import.meta.dirname, "..", "sandbox");
  const js = path.join(dir, "boot.js");
  const file = existsSync(js) ? js : path.join(dir, "boot.ts");
  return (await import(
    pathToFileURL(file).href
  )) as typeof import("../sandbox/boot.js");
}

/** Captured BEFORE the sandbox revokes the global. */
const hostFetch = globalThis.fetch;

/**
 * Own global keys as of the first run, captured AFTER the sandbox installs so
 * the sandbox's own marks are part of the baseline. A reused thread shares one
 * global object, so anything a handler parks there would otherwise be readable
 * by the NEXT handler — possibly another app's. Scrubbing before each graph
 * loads closes that channel; it is not a realm, and a non-configurable global
 * still cannot be removed.
 */
let baselineGlobals: Set<string | symbol> | undefined;

function scrubHandlerGlobals(): void {
  const scope = globalThis as unknown as Record<PropertyKey, unknown>;
  if (!baselineGlobals) {
    baselineGlobals = new Set(Reflect.ownKeys(scope));
    return;
  }
  for (const key of Reflect.ownKeys(scope)) {
    if (baselineGlobals.has(key)) continue;
    try {
      delete scope[key];
    } catch {
      /* non-configurable: never ours to remove */
    }
  }
}

/**
 * Retire the thread after this many runs. Each run imports the handler under a
 * fresh URL, and Node's module registry never drops one, so the cost of a
 * fresh graph is a registry that grows with the thread's age. This is the
 * resource-limit guard for that growth — reached before `resourceLimits`
 * would kill a worker MID-RUN and fail a member's request.
 */
const MAX_RUNS_PER_WORKER = 64;

let runsServed = 0;

let tsLoaderRegistered = false;
function ensureTsLoader(): void {
  if (tsLoaderRegistered) return;
  tsLoaderRegistered = true;
  const here = import.meta.dirname;
  const jsHooks = path.join(here, "ts-loader-hooks.js");
  const hooksFile = existsSync(jsHooks)
    ? jsHooks
    : path.join(here, "ts-loader-hooks.ts");
  register(pathToFileURL(hooksFile).href);
}

interface WorkerRequest {
  handlerFile: string;
  handlerKind: "query" | "action";
  args: unknown;
  timeModuleUrl?: string;
}

interface RunMessage {
  type: "run";
  request: WorkerRequest;
}

interface VaultCallMessage {
  type: "vault";
  id: number;
  op:
    | "read"
    | "search"
    | "invoke"
    | "describe"
    | "parked"
    | "changes"
    | "resolve"
    | "reveal"
    | "authenticate"
    | "content";
  payload: unknown;
}

interface VaultReplyMessage {
  type: "vault-reply";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
  /** Set when the refusal is a revocation; see VaultCallResult.revokedAt. */
  revokedAt?: string;
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
  /** The thread has served its run budget: park nothing, terminate it. */
  retire?: boolean;
  /**
   * The sandbox this THREAD is now committed to, as installed — not as the
   * parent guessed. The pool parks under this, so a mis-hinted run can only
   * cost a thread, never leak a lane's grant into the next run.
   */
  sandboxKey?: string;
}

if (!parentPort) {
  throw new Error("centraid handler worker must be run as a worker_thread");
}

const port = parentPort;
const boot = workerData as { pooled?: boolean } & Partial<WorkerRequest>;

port.on("message", (msg: VaultReplyMessage | RunMessage) => {
  if (msg.type === "vault-reply") {
    const pending = pendingVaultCalls.get(msg.id);
    if (!pending) return;
    pendingVaultCalls.delete(msg.id);
    if (msg.ok) pending.resolve(msg.result);
    else {
      const err = new Error(msg.error ?? "vault call failed") as Error & {
        code?: string;
        revokedAt?: string;
      };
      if (msg.code) err.code = msg.code;
      if (msg.revokedAt) err.revokedAt = msg.revokedAt;
      pending.reject(err);
    }
  } else if (msg.type === "run") {
    execute(msg.request);
  }
});

// The parent enforces consent; a refusal rejects with the receipt id and a
// machine `code`. No key or file handle ever enters this thread.

let nextVaultCallId = 1;
const pendingVaultCalls = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

function vaultCall(
  op: VaultCallMessage["op"],
  payload: unknown
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextVaultCallId++;
    pendingVaultCalls.set(id, { resolve, reject });
    const m: VaultCallMessage = { type: "vault", id, op, payload };
    port.postMessage(m);
  });
}

const vault = {
  read(request: Record<string, unknown>): Promise<unknown> {
    return vaultCall("read", request);
  },
  search(request: Record<string, unknown>): Promise<unknown> {
    return vaultCall("search", request);
  },
  invoke(request: Record<string, unknown>): Promise<unknown> {
    return vaultCall("invoke", request);
  },
  describe(): Promise<unknown> {
    return vaultCall("describe", {});
  },
  parked(): Promise<unknown> {
    return vaultCall("parked", {});
  },
  /** Resolvable only when a live `core.link` connects the ref to something
   *  this caller reads (#272). */
  resolve(request: Record<string, unknown>): Promise<unknown> {
    return vaultCall("resolve", request);
  },
  reveal(request: Record<string, unknown>): Promise<unknown> {
    return vaultCall("reveal", request);
  },
  authenticate(request: Record<string, unknown>): Promise<unknown> {
    return vaultCall("authenticate", request);
  },
  content(request: Record<string, unknown>): Promise<unknown> {
    return vaultCall("content", request);
  },
};

const log = {
  info: (msg: string) =>
    port.postMessage({ type: "log", level: "info", msg } satisfies LogMessage),
  warn: (msg: string) =>
    port.postMessage({ type: "log", level: "warn", msg } satisfies LogMessage),
  error: (msg: string) =>
    port.postMessage({ type: "log", level: "error", msg } satisfies LogMessage),
};

/** One per run: the previous run's controller is aborted in its `finally`, so
 *  a shared one would hand run N+1 a dead signal. */
let abortController = new AbortController();
function baseCtx() {
  const signal = abortController.signal;
  return {
    fetch: (input: string, init?: RequestInit) =>
      hostFetch(input, { ...init, signal }),
    abortSignal: signal,
    vault,
  };
}

function execute(req: WorkerRequest): void {
  runsServed += 1;
  abortController = new AbortController();
  let sandboxKey: string | undefined;
  void (async () => {
    try {
      const unavailableTime = (): never => {
        throw new Error("handler host did not mount the civil-time capability");
      };
      const timeModule = req.timeModuleUrl
        ? ((await import(req.timeModuleUrl)) as {
            applyRecurrenceExceptions: (...args: unknown[]) => unknown;
            collapseMissedOccurrences: (...args: unknown[]) => unknown;
            describeRecurrence: (...args: unknown[]) => unknown;
            expandRecurrence: (...args: unknown[]) => unknown;
            shiftTemporal: (...args: unknown[]) => unknown;
          })
        : {
            applyRecurrenceExceptions: unavailableTime,
            collapseMissedOccurrences: unavailableTime,
            describeRecurrence: unavailableTime,
            expandRecurrence: unavailableTime,
            shiftTemporal: unavailableTime,
          };
      const time = Object.freeze({
        applyRecurrenceExceptions: timeModule.applyRecurrenceExceptions,
        collapseMissedOccurrences: timeModule.collapseMissedOccurrences,
        describeRecurrence: timeModule.describeRecurrence,
        expandRecurrence: timeModule.expandRecurrence,
        shiftTemporal: timeModule.shiftTemporal,
      });
      if (/\.tsx?$/u.test(req.handlerFile)) ensureTsLoader();
      // Containment goes on LAST, immediately before the untrusted graph is
      // reachable. The handler file is the taint root.
      const { loadSandbox } = await loadSandboxBoot();
      const sandboxApi = await loadSandbox();
      // Lane chosen per file, so no handler inherits the seed's `fs` grant.
      const isSeed = /(?:^|[\\/])seed\.(?:m?js|tsx?)$/u.test(req.handlerFile);
      const sandbox = sandboxApi.installWorkerSandbox(
        isSeed
          ? sandboxApi.appSeedPolicy(path.dirname(req.handlerFile))
          : sandboxApi.appHandlerPolicy(),
        { redactLaunchArgs: true }
      );
      // A seed's grant is scoped to ITS app dir, so the dir is part of the
      // identity two runs must share to run on one thread.
      sandboxKey = isSeed
        ? `app-seed:${path.dirname(req.handlerFile)}`
        : sandbox.policy.lane;
      scrubHandlerGlobals();
      sandbox.taint(pathToFileURL(req.handlerFile).href);
      // A per-run URL, not the bare one: the registry key differs, so the
      // handler graph is evaluated again and carries no state from the last
      // run. The taint set and the resolve hook both strip the query.
      const mod = (await import(
        `${pathToFileURL(req.handlerFile).href}?centraid-run=${runsServed}`
      )) as {
        default?: (args: unknown) => Promise<unknown>;
      };
      if (typeof mod.default !== "function") {
        throw new Error(`${req.handlerFile} has no default export`);
      }
      const fullArgs = {
        ...(req.args as object),
        log,
        ctx: { ...baseCtx(), time },
      };
      const value = await mod.default(fullArgs);
      port.postMessage({
        type: "result",
        ok: true,
        value,
        ...(sandboxKey ? { sandboxKey } : {}),
        ...(runsServed >= MAX_RUNS_PER_WORKER ? { retire: true } : {}),
      } satisfies ResultMessage);
    } catch (error) {
      port.postMessage({
        type: "result",
        ok: false,
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
        ...(sandboxKey ? { sandboxKey } : {}),
        ...(runsServed >= MAX_RUNS_PER_WORKER ? { retire: true } : {}),
      } satisfies ResultMessage);
    } finally {
      abortController.abort();
      // A late reply for a run that already ended must never resolve into the
      // next one. Dropped, not rejected: a call the handler abandoned has no
      // `catch`, and an unhandled rejection would kill a thread that is about
      // to serve someone else.
      pendingVaultCalls.clear();
    }
  })();
}

if (boot.pooled) {
  port.postMessage({ type: "ready" });
} else {
  execute(boot as WorkerRequest);
}
