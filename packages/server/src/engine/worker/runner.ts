/**
 * Worker entry that executes one user handler. The app-handler sandbox is
 * installed before the handler graph is imported (#842), so network reach
 * survives only as `ctx.fetch` and the only data door is `ctx.vault`. It is
 * still NOT an OS sandbox — read `../sandbox/install.ts`'s limits before
 * describing this boundary in a threat model. A worker runs EXACTLY ONE
 * handler and is discarded (#404), so no thread ever imports two.
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
    | "query"
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
      };
      if (msg.code) err.code = msg.code;
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
  query(view: string, purpose: string): Promise<unknown> {
    return vaultCall("query", { view, purpose });
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

const abortController = new AbortController();
const baseCtx = {
  fetch: (input: string, init?: RequestInit) =>
    hostFetch(input, { ...init, signal: abortController.signal }),
  abortSignal: abortController.signal,
  vault,
};

function execute(req: WorkerRequest): void {
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
      sandbox.taint(pathToFileURL(req.handlerFile).href);
      const mod = (await import(pathToFileURL(req.handlerFile).href)) as {
        default?: (args: unknown) => Promise<unknown>;
      };
      if (typeof mod.default !== "function") {
        throw new Error(`${req.handlerFile} has no default export`);
      }
      const fullArgs = {
        ...(req.args as object),
        log,
        ctx: { ...baseCtx, time },
      };
      const value = await mod.default(fullArgs);
      port.postMessage({
        type: "result",
        ok: true,
        value,
      } satisfies ResultMessage);
    } catch (error) {
      port.postMessage({
        type: "result",
        ok: false,
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      } satisfies ResultMessage);
    } finally {
      abortController.abort();
    }
  })();
}

if (boot.pooled) {
  port.postMessage({ type: "ready" });
} else {
  execute(boot as WorkerRequest);
}
