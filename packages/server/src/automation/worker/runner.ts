/** Automation worker: isolates crashes/timeouts, not trusted app code. `ctx.delegate`
 * is the only billed rail; every `ctx.*` call is an ordered parent RPC barrier. */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

async function loadThreadReuse(): Promise<
  typeof import("../../engine/worker/thread-reuse.js")
> {
  const dir = path.join(import.meta.dirname, "..", "..", "engine", "worker");
  const js = path.join(dir, "thread-reuse.js");
  const file = existsSync(js) ? js : path.join(dir, "thread-reuse.ts");
  return (await import(
    pathToFileURL(file).href
  )) as typeof import("../../engine/worker/thread-reuse.js");
}

/** Absolute path: a relative `.js` specifier does not resolve under native
 *  type stripping. */
async function loadSandboxBoot(): Promise<
  typeof import("../../engine/sandbox/boot.js")
> {
  const dir = path.join(import.meta.dirname, "..", "..", "engine", "sandbox");
  const js = path.join(dir, "boot.js");
  const file = existsSync(js) ? js : path.join(dir, "boot.ts");
  return (await import(
    pathToFileURL(file).href
  )) as typeof import("../../engine/sandbox/boot.js");
}

/**
 * The lane the PARENT chose (#842) — never the handler bundle or its manifest;
 * handler-chosen containment would be no containment. Lane widths: policy.ts.
 * There is no "no sandbox" option (#846); `automation-handler` is the floor.
 */
type SandboxLaneRequest =
  | "automation-handler"
  | "media-transcode"
  | "model-runtime";

interface WorkerRequest {
  handlerFile: string;
  args: unknown;
  /** Absent means the `automation-handler` floor. */
  sandboxLane?: SandboxLaneRequest;
  sandboxReadRoots?: string[];
  /** Planted on `globalThis` before the handler's graph loads: a sandboxed
   *  handler has no `process.env` (#846). A path, not a capability. */
  sandboxRuntimeDir?: string;
  /** Fixed by the parent for the whole run. */
  now: string;
  input?: unknown;
}

type ParentReply = {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
};
type ParentMessage =
  | ({
      type:
        | "delegate-reply"
        | "state-reply"
        | "runs-reply"
        | "fetch-reply"
        | "connector-open-reply";
    } & ParentReply)
  | ({ type: "vault-reply"; code?: string } & ParentReply)
  | { type: "abort"; reason?: string }
  | { type: "run"; request: WorkerRequest };

export interface FetchSpec {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  content?: { contentId: string; variant: string; maxBytes?: number }[];
}

type WorkerMessage =
  | {
      type: "delegate";
      id: number;
      prompt: string;
      json?: unknown;
      harness?: string;
      model?: string;
      configPins?: Record<string, string>;
      content?: { contentId: string; variant: string; maxBytes?: number }[];
    }
  | {
      type: "state";
      id: number;
      method: "get" | "set" | "delete";
      key: string;
      value?: unknown;
    }
  | {
      type: "runs";
      id: number;
      method: "last" | "list";
      filter: {
        automationId?: string;
        status?: "ok" | "error";
        since?: number;
        limit?: number;
      };
    }
  | {
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
        | "content";
      payload: Record<string, unknown>;
    }
  | { type: "fetch"; id: number; spec: FetchSpec }
  | { type: "connector-open"; id: number; principal: string }
  | { type: "log"; level: "info" | "warn" | "error"; msg: string }
  | {
      type: "result";
      ok: boolean;
      value?: unknown;
      error?: string;
      /** The thread has served its run budget: terminate rather than park. */
      retire?: boolean;
      /** The sandbox this THREAD is committed to, as installed. */
      sandboxKey?: string;
    };

if (!parentPort) {
  throw new Error("centraid automation worker must be run as a worker_thread");
}
const port = parentPort;
const { automationRunSandboxKey, createThreadSession } =
  await loadThreadReuse();
const session = createThreadSession();

const boot = workerData as { pooled?: boolean } & Partial<WorkerRequest>;
let req = boot as WorkerRequest;

let nextCallId = 1;
const pendingCalls = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

/** Omit that distributes over a union instead of collapsing it to common keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type RpcRequest = DistributiveOmit<
  Exclude<WorkerMessage, { type: "log" } | { type: "result" }>,
  "id"
>;

/** Each `ctx.*` call is an ordering barrier. */
function rpcCall(msg: RpcRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextCallId++;
    pendingCalls.set(id, { resolve, reject });
    port.postMessage({ ...msg, id } as WorkerMessage);
  });
}

function rejectAllPending(reason: string): void {
  const err = new Error(reason);
  for (const [, p] of pendingCalls) p.reject(err);
  pendingCalls.clear();
}

port.on("message", (msg: ParentMessage) => {
  if (msg.type === "run") {
    execute(msg.request);
    return;
  }
  if (
    msg.type === "delegate-reply" ||
    msg.type === "state-reply" ||
    msg.type === "runs-reply" ||
    msg.type === "fetch-reply" ||
    msg.type === "vault-reply" ||
    msg.type === "connector-open-reply"
  ) {
    const p = pendingCalls.get(msg.id);
    if (!p) return;
    pendingCalls.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else {
      const err = new Error(
        msg.error ?? `${msg.type.replace("-reply", "")} call failed`
      ) as Error & {
        code?: string;
      };
      if ("code" in msg && msg.code) err.code = msg.code;
      p.reject(err);
    }
    return;
  }
  if (msg.type === "abort") {
    const reason = msg.reason ?? "aborted";
    session.abort(reason);
    rejectAllPending(reason);
  }
});

const log = {
  info: (msg: string) =>
    port.postMessage({
      type: "log",
      level: "info",
      msg,
    } satisfies WorkerMessage),
  warn: (msg: string) =>
    port.postMessage({
      type: "log",
      level: "warn",
      msg,
    } satisfies WorkerMessage),
  error: (msg: string) =>
    port.postMessage({
      type: "log",
      level: "error",
      msg,
    } satisfies WorkerMessage),
};

const state = {
  get<T = unknown>(key: string): Promise<T | undefined> {
    return rpcCall({ type: "state", method: "get", key }) as Promise<
      T | undefined
    >;
  },
  async set(key: string, value: unknown): Promise<void> {
    await rpcCall({ type: "state", method: "set", key, value });
  },
  async delete(key: string): Promise<void> {
    await rpcCall({ type: "state", method: "delete", key });
  },
};

const runs = {
  last(
    filter: { automationId?: string; status?: "ok" | "error" } = {}
  ): Promise<unknown> {
    return rpcCall({ type: "runs", method: "last", filter });
  },
  list(
    filter: {
      automationId?: string;
      status?: "ok" | "error";
      since?: number;
      limit?: number;
    } = {}
  ): Promise<unknown> {
    return rpcCall({ type: "runs", method: "list", filter });
  },
};

// The worker carries capability, never a key: the parent resolves this
// automation to its enrolled `access.agent` credential host-side.
function vaultCall(
  op:
    | "read"
    | "search"
    | "invoke"
    | "describe"
    | "parked"
    | "changes"
    | "resolve"
    | "reveal"
    | "content",
  payload: Record<string, unknown>
): Promise<unknown> {
  return rpcCall({ type: "vault", op, payload });
}

const vault = {
  read(request: Record<string, unknown>): Promise<unknown> {
    return vaultCall("read", request);
  },
  /** Match vault-side, never grep a read. */
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
  changes(request: Record<string, unknown>): Promise<unknown> {
    return vaultCall("changes", request);
  },
  resolve(request: Record<string, unknown>): Promise<unknown> {
    return vaultCall("resolve", request);
  },
  /** Plaintext of sealed columns; receipted per item (#293). */
  reveal(request: Record<string, unknown>): Promise<unknown> {
    return vaultCall("reveal", request);
  },
  /** Derivatives only — originals never egress (#299). */
  content(request: Record<string, unknown>): Promise<unknown> {
    return vaultCall("content", request);
  },
};

const ctx = {
  /** Deterministic on replay. */
  now: req.now,
  /** `{{secret:locker:<item_id>:<column>}}` placeholders are substituted by
   *  the host; the plaintext secret never enters this worker. */
  fetch(spec: FetchSpec): Promise<{
    status: number;
    headers: Record<string, string>;
    text: string;
  }> {
    return rpcCall({ type: "fetch", spec }) as Promise<{
      status: number;
      headers: Record<string, string>;
      text: string;
    }>;
  },
  /** The ONLY billed rail. `content` names vault derivatives the HOST resolves
   *  under this automation's grant; the worker never holds the bytes (#299). */
  delegate(args: {
    prompt: string;
    json?: unknown;
    harness?: string;
    model?: string;
    configPins?: Record<string, string>;
    content?: { contentId: string; variant: string; maxBytes?: number }[];
  }): Promise<unknown> {
    return rpcCall({
      type: "delegate",
      prompt: args.prompt,
      ...(args.json === undefined ? {} : { json: args.json }),
      ...(args.harness === undefined ? {} : { harness: args.harness }),
      ...(args.model === undefined ? {} : { model: args.model }),
      ...(args.configPins === undefined ? {} : { configPins: args.configPins }),
      ...(args.content === undefined ? {} : { content: args.content }),
    });
  },
  state,
  runs,
  vault,
  input: req.input,
  get abortSignal(): AbortSignal {
    return session.signal;
  },
};

interface PullRow {
  entity_type: string;
  external_id: string;
  payload: Record<string, unknown>;
}

interface PullContext {
  readonly now: string;
  readonly input: unknown;
  readonly abortSignal: AbortSignal;
  readonly fetch: typeof ctx.fetch;
}

interface PullSpec {
  protocol: "centraid.pull/v1";
  principal: (args: { ctx: PullContext; log: typeof log }) => Promise<string>;
  pull: (args: {
    ctx: PullContext;
    log: typeof log;
    cursor: ReturnType<typeof cursorManager>;
  }) => Promise<{ rows: PullRow[]; summary?: string }>;
}

function cursorManager(initial: Record<string, unknown>) {
  const updates = new Map<string, unknown>();
  return {
    highWater(key: string) {
      const initialValue = initial[key];
      let value =
        typeof initialValue === "string" || typeof initialValue === "number"
          ? initialValue
          : undefined;
      return {
        current: value,
        observe(candidate: string | number | null | undefined): void {
          if (candidate === null || candidate === undefined) return;
          if (value !== undefined && typeof candidate !== typeof value) {
            throw new Error(`high-water cursor "${key}" changed value type`);
          }
          if (value === undefined || candidate > value) value = candidate;
          updates.set(key, value);
        },
      };
    },
    provider(key: string) {
      let value = initial[key];
      return {
        get current(): unknown {
          return value;
        },
        set(next: unknown): void {
          value = next;
          updates.set(key, next);
        },
        clear(): void {
          value = null;
          updates.set(key, null);
        },
      };
    },
    entries(): [string, unknown][] {
      return [...updates.entries()];
    },
  };
}

async function executePullSpec(spec: PullSpec): Promise<unknown> {
  // Pull specs get no vault/state/runs/delegate rails; identity, staging,
  // cursors and finish stay the parent engine's.
  const pullCtx: PullContext = {
    now: ctx.now,
    input: ctx.input,
    abortSignal: ctx.abortSignal,
    fetch: ctx.fetch,
  };
  const principal = await spec.principal({ ctx: pullCtx, log });
  if (typeof principal !== "string" || principal.trim().length === 0) {
    throw new Error("pull connector principal probe returned no identity");
  }
  const openedRaw = await rpcCall({
    type: "connector-open",
    principal: principal.trim(),
  });
  const opened =
    openedRaw && typeof openedRaw === "object" && "output" in openedRaw
      ? (openedRaw as { output: Record<string, unknown> }).output
      : (openedRaw as Record<string, unknown>);
  if (!opened || typeof opened !== "object") {
    throw new Error("pull connector run scope returned no result");
  }
  if (opened.refused) {
    return {
      summary: `skipped: ${String(opened.reason ?? opened.refused)}`,
      output: { skipped: true },
    };
  }
  const cursor = cursorManager(
    (opened.cursors as Record<string, unknown>) ?? {}
  );
  const result = await spec.pull({ ctx: pullCtx, log, cursor });
  return {
    __centraidPull: {
      rows: result.rows,
      cursors: cursor.entries(),
      ...(result.summary ? { summary: result.summary } : {}),
    },
  };
}

function execute(request: WorkerRequest): void {
  session.beginRun();
  req = request;
  ctx.now = request.now;
  ctx.input = request.input;
  let sandboxKey: string | undefined;
  void (async () => {
    try {
      {
        // Before the sandbox installs: it freezes `process.env` empty.
        if (request.sandboxRuntimeDir !== undefined) {
          (globalThis as Record<string, unknown>)[
            "__centraidAutomationRuntimeDir"
          ] = request.sandboxRuntimeDir;
        }
        // Unconditional (#846): an absent lane is the floor, not "none".
        const sandboxApi = await (await loadSandboxBoot()).loadSandbox();
        const roots = request.sandboxReadRoots ?? [];
        const policy =
          request.sandboxLane === "model-runtime"
            ? sandboxApi.modelRuntimePolicy(roots)
            : request.sandboxLane === "media-transcode"
              ? sandboxApi.mediaTranscodePolicy(roots)
              : sandboxApi.automationHandlerPolicy();
        const sandbox = sandboxApi.installWorkerSandbox(policy, {
          redactLaunchArgs: true,
        });
        sandbox.taint(pathToFileURL(req.handlerFile).href);
        sandboxKey = automationRunSandboxKey(
          sandbox.policy.lane,
          roots,
          request.sandboxRuntimeDir
        );
        session.scrub();
      }
      const mod = (await import(session.importHref(req.handlerFile))) as {
        default?: ((args: unknown) => Promise<unknown>) | PullSpec;
      };
      if (
        typeof mod.default !== "function" &&
        !(
          mod.default &&
          mod.default.protocol === "centraid.pull/v1" &&
          typeof mod.default.principal === "function" &&
          typeof mod.default.pull === "function"
        )
      ) {
        throw new Error(`${req.handlerFile} has no default export`);
      }
      const fullArgs = { ...(req.args as object), log, ctx };
      const value =
        typeof mod.default === "function"
          ? await mod.default(fullArgs)
          : await executePullSpec(mod.default);
      port.postMessage({
        type: "result",
        ok: true,
        value,
        ...session.resultFlags(sandboxKey),
      } satisfies WorkerMessage);
    } catch (error) {
      port.postMessage({
        type: "result",
        ok: false,
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
        ...session.resultFlags(sandboxKey),
      } satisfies WorkerMessage);
    } finally {
      session.finish(pendingCalls);
    }
  })();
}

if (boot.pooled) port.postMessage({ type: "ready" });
else execute(boot as WorkerRequest);
