// governance: allow-repo-hygiene file-size-limit the parent-side handler orchestrator is one message-pump — delegate/fetch/state/vault dispatch plus the #293 secret and #304 connection injection all share the one worker-boundary protocol, so splitting scatters the wire contract
/**
 * Parent-side orchestrator for automation handlers (#98). Only
 * `delegateDispatcher` (the one billed rail) comes from the host; the rest of
 * the ctx surface is serviced here in-process. Every ctx call becomes one
 * `run_nodes` audit row, and there is NO runtime retry.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  appendLogs,
  WorkerPool,
  workerPoolSizeFromEnv,
  workerResourceLimitsFromEnv,
} from "@centraid/server/engine";
import type {
  LogEntry,
  ConversationStore,
  AutomationTriggerKind,
  AutomationTriggerOrigin,
  TurnStreamEvent,
  AutomationTurnStreamEvent,
  VaultBridge,
  VaultOp,
} from "@centraid/server/engine";

import { validateOutputAgainstSchema } from "../manifest/manifest-output.js";
import type { HistoryConfig, OutputSchema } from "../manifest/manifest.js";
import {
  applyRetention,
  extractReturnEnvelope,
  noopRunEventSink,
  truncateForAudit,
} from "./audit.js";
import type { HandlerReturnEnvelope } from "./audit.js";
import {
  handleDelegateMessage,
  handleRunsMessage,
  handleStateMessage,
  handleVaultMessage,
} from "./ctx.js";
import type { AuditState } from "./ctx.js";

function resolveWorkerFile(): string {
  const here = import.meta.dirname;
  const jsPath = path.join(here, "..", "worker", "runner.js");
  if (existsSync(jsPath)) return jsPath;
  // Under tsx no .js is emitted; its loader reaches spawned Workers via
  // NODE_OPTIONS, so the .ts fallback works.
  return path.join(here, "..", "worker", "runner.ts");
}

const WORKER_FILE = resolveWorkerFile();
let automationWorkerPoolInstance: WorkerPool | undefined;

function automationWorkerPool(): WorkerPool {
  if (!automationWorkerPoolInstance) {
    automationWorkerPoolInstance = new WorkerPool(
      WORKER_FILE,
      workerPoolSizeFromEnv(),
      workerResourceLimitsFromEnv()
    );
    automationWorkerPoolInstance.prewarm();
  }
  return automationWorkerPoolInstance;
}

export interface DelegateAttachment {
  readonly name: string;
  readonly mediaType: string;
  readonly base64?: string;
  readonly text?: string;
}

export interface DelegateCall {
  readonly prompt: string;
  readonly json?: unknown;
  readonly harness?: string;
  readonly model?: string;
  readonly configPins?: Readonly<Record<string, string>>;
  readonly attachments?: readonly DelegateAttachment[];
  readonly onEvent?: (ev: TurnStreamEvent) => void;
}

export type DelegateDispatcher = (
  call: DelegateCall,
  ctx: DispatchContext
) => Promise<unknown>;

export interface DispatchContext {
  readonly runId: string;
  readonly automationId: string;
  readonly abortSignal: AbortSignal;
}

export interface RunHandlerOptions {
  automationId: string;
  automationName?: string;
  automationDir: string;
  handlerFile: string;
  /** Absent is the strict `automation-handler` floor, never "no sandbox". */
  sandboxLane?: "model-runtime" | "media-transcode";
  sandboxReadRoots?: readonly string[];
  sandboxRuntimeDir?: string;
  runId: string;
  now?: string;
  delegateDispatcher: DelegateDispatcher;
  runsStore: ConversationStore;
  finalizeTurn?: (
    store: ConversationStore,
    conversationId: string,
    turnId: string,
    ok: boolean
  ) => void;
  harnessKind?: string;
  model?: string;
  /** Bound to this automation's enrolled agent credential; absent → every
   *  `ctx.vault` call fails closed with `VAULT_UNAVAILABLE`. */
  vault?: VaultBridge;
  onRunEvent?: (ev: AutomationTurnStreamEvent) => void;
  triggerKind?: AutomationTriggerKind;
  triggerOrigin?: AutomationTriggerOrigin;
  note?: string;
  failoverNotice?: string;
  input?: unknown;
  parentRunId?: string;
  outputSchema?: OutputSchema;
  history?: HistoryConfig;
  timeoutMs?: number;
  /** Connector confinement (#290): `ctx.delegate` is forbidden entirely and
   *  `ctx.fetch` is the only external rail. `secrets` is the allowlist for
   *  `{{secret:…}}` placeholders (#293). */
  connector?: {
    readonly kind: string;
    readonly label: string;
    readonly secrets?: readonly string[];
    /** Injected past the worker boundary (#524), so published handler code
     *  cannot fork a label-based shadow connection after a rename. */
    readonly connectionId?: string;
  };
  /** ref → plaintext (#293). Substitution happens on THIS side of the worker
   *  boundary, and the value is scrubbed from every recorded string. */
  resolveSecret?: (ref: string) => Promise<string>;
  connectionAuth?: ConnectionAuth;
  fetchRetryDelaysMs?: readonly number[];
}

/** The token never crosses the worker boundary (#304): `values` substitute
 *  parent-side and `allowedHosts` is the anti-exfiltration pin. */
export interface ConnectionAuth {
  readonly values: Readonly<Record<string, string>>;
  readonly allowedHosts: readonly string[];
  readonly refresh?: () => Promise<Readonly<Record<string, string>>>;
  readonly onAuthDead?: (reason: string) => Promise<void>;
  readonly limit?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Default (unset) = READ-ONLY. Connector fires never set this: external
   *  writes ride `outbox.stage` (#306), never raw ctx.fetch. */
  readonly allowWrites?: boolean;
  readonly readOnlyPosts?: readonly {
    readonly host: string;
    readonly path: string;
    readonly body: "json" | "graphql-query";
  }[];
}

export function isBrokerReadOnlyPost(
  policies: ConnectionAuth["readOnlyPosts"],
  url: URL,
  body: string | undefined
): boolean {
  const policy = policies?.find(
    (entry) => entry.host === url.hostname && entry.path === url.pathname
  );
  if (!policy || body === undefined) return false;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (policy.body === "json") return true;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { query?: unknown }).query !== "string"
    ) {
      return false;
    }
    // Erring closed: no GraphQL mutation through the read-only POST exception.
    const document = (parsed as { query: string }).query
      .replace(/#[^\r\n]*/gu, "")
      .replace(/"""[\s\S]*?"""/gu, '""')
      .replace(/"(?:\\.|[^"\\])*"/gu, '""');
    return !/\b(?:mutation|subscription)\b/iu.test(document);
  } catch {
    return false;
  }
}

function bindConnectorVaultPayload(
  op: string,
  payload: Record<string, unknown>,
  connectionId: string | undefined
): Record<string, unknown> {
  if (op !== "invoke" || !connectionId) return payload;
  if (
    payload.command !== "sync.begin_run" &&
    payload.command !== "sync.stage_rows"
  )
    return payload;
  const input =
    payload.input &&
    typeof payload.input === "object" &&
    !Array.isArray(payload.input)
      ? (payload.input as Record<string, unknown>)
      : {};
  return { ...payload, input: { ...input, connection_id: connectionId } };
}

export interface HandlerOutcome {
  ok: boolean;
  /** The fire ended BEFORE the handler ran, on state the owner chose or has
   *  seen. NOT a failure: reporting a skip as one spams a notice every tick
   *  while a connection stays paused (#647). */
  skipped?: boolean;
  /** Set when the ENRICHMENT TIER GATE refused the fire. Structured, not
   *  pattern-matched out of `error`, because the host must name the domain and
   *  the control that changes it. Absent on every other skip. */
  enrichRefusal?: {
    domain: string;
    capability: string;
    tier?: string;
  };
  value?: unknown;
  summary?: string;
  output?: unknown;
  error?: string;
  logs: Array<{ level: "info" | "warn" | "error"; msg: string }>;
  toolBatches: number;
  delegateCalls: number;
}

interface PendingState {
  resolve: (outcome: HandlerOutcome) => void;
  resolved: boolean;
}

interface FetchSpecWire {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  content?: { contentId: string; variant: string; maxBytes?: number }[];
}

type WorkerToParentMessage =
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
  | { type: "fetch"; id: number; spec: FetchSpecWire }
  | { type: "connector-open"; id: number; principal: string }
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
  | { type: "vault"; id: number; op: VaultOp; payload: Record<string, unknown> }
  | { type: "log"; level: "info" | "warn" | "error"; msg: string }
  | {
      type: "result";
      ok: boolean;
      value?: unknown;
      error?: string;
      /** The thread has served its run budget: terminate rather than park. */
      retire?: boolean;
      /** The sandbox the thread actually installed. */
      sandboxKey?: string;
    };

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Handler actions must stay in author order; independent work belongs behind
 *  an explicit concurrent helper. */
function applyInOrder<T>(
  values: Iterable<T>,
  apply: (value: T, index: number) => void | PromiseLike<void>
): Promise<void> {
  let index = 0;
  return Array.from(values).reduce<Promise<void>>(
    (sequence, value) => sequence.then(() => apply(value, index++)),
    Promise.resolve()
  );
}

export async function runHandler(
  opts: RunHandlerOptions
): Promise<HandlerOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const logs: HandlerOutcome["logs"] = [];
  const persistedEntries: LogEntry[] = [];
  const handlerName = path.basename(opts.handlerFile).replace(/\.js$/u, "");

  const abortController = new AbortController();
  const dispatchCtx: DispatchContext = {
    runId: opts.runId,
    automationId: opts.automationId,
    abortSignal: abortController.signal,
  };

  const toolBatches = 0;
  let delegateCalls = 0;

  // Transport-level substitution; this set powers the backstop scrub (#293).
  const resolvedSecretValues = new Set<string>();
  const scrub = (text: string): string => {
    let out = text;
    for (const value of resolvedSecretValues) {
      for (const needle of [value, JSON.stringify(value).slice(1, -1)]) {
        if (needle) out = out.replaceAll(needle, "«secret»");
      }
    }
    return out;
  };
  const SECRET_REF_RE = /\{\{secret:(?<ref>[^}]+)\}\}/gu;
  const CONNECTION_REF_RE = /\{\{connection:(?<name>[a-z_]+)\}\}/gu;
  const substituteSecrets = async (
    spec: FetchSpecWire,
    connectionValues: Readonly<Record<string, string>>
  ): Promise<{ spec: FetchSpecWire; injected: boolean }> => {
    const allow = new Set(opts.connector?.secrets);
    const resolved = new Map<string, string>();
    let injected = false;
    const substitute = async (text: string): Promise<string> => {
      const refs = [...text.matchAll(SECRET_REF_RE)].map(
        (match) => match.groups!.ref!
      );
      let out = text;
      await applyInOrder(refs, async (ref) => {
        if (!allow.has(ref)) {
          throw new Error(
            `secret "${ref}" is outside this connector's requires.secrets allowlist (issue #293)`
          );
        }
        if (!resolved.has(ref)) {
          if (!opts.resolveSecret)
            throw new Error("no secret resolver is available for this run");
          const value = await opts.resolveSecret(ref);
          resolved.set(ref, value);
          resolvedSecretValues.add(value);
        }
        out = out.replaceAll(`{{secret:${ref}}}`, resolved.get(ref)!);
      });
      // An unknown placeholder name — or no broker credential — is a handler
      // bug surfaced as an error, never an empty substitution (#304).
      for (const match of out.matchAll(CONNECTION_REF_RE)) {
        const name = match.groups!.name!;
        const value = connectionValues[name];
        if (value === undefined) {
          throw new Error(
            Object.keys(connectionValues).length === 0
              ? "this connection carries no broker credential — attach one with sync.configure_credential (issue #304)"
              : `connection credential has no "${name}" value (carries: ${Object.keys(connectionValues).join(", ")})`
          );
        }
        injected = true;
        resolvedSecretValues.add(value);
        out = out.replaceAll(`{{connection:${name}}}`, value);
      }
      return out;
    };
    const headers: Record<string, string> = {};
    await applyInOrder(
      Object.entries(spec.headers ?? {}),
      async ([key, value]) => {
        headers[key] = await substitute(value);
      }
    );
    return {
      spec: {
        url: await substitute(spec.url),
        ...(spec.method ? { method: spec.method } : {}),
        ...(spec.headers ? { headers } : {}),
        ...(spec.body === undefined
          ? {}
          : { body: await substitute(spec.body) }),
      },
      injected,
    };
  };

  // Destination pin for EVERY ctx.fetch (#304, #865): https only (loopback
  // excepted), and when a broker credential rides this fire, only toward its
  // allowed_hosts.
  const hostAllowed = (url: URL): boolean =>
    (opts.connectionAuth?.allowedHosts ?? []).some((entry) =>
      entry.startsWith("*.")
        ? url.hostname.endsWith(entry.slice(1)) &&
          url.hostname.length > entry.length - 1
        : url.hostname === entry
    );
  const isLoopback = (url: URL): boolean =>
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
  const assertFetchDestination = (rawUrl: string): void => {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && !isLoopback(url)) {
      throw new Error(
        `ctx.fetch refuses non-https destination ${url.hostname} (issue #304)`
      );
    }
    if (opts.connectionAuth && !hostAllowed(url)) {
      throw new Error(
        `host "${url.hostname}" is outside this connection's allowed_hosts — the credential is pinned to ${(opts.connectionAuth?.allowedHosts ?? []).join(", ")} (issue #304)`
      );
    }
  };
  const assertInjectable = (
    rawUrl: string,
    method: string,
    body?: string
  ): void => {
    assertFetchDestination(rawUrl);
    const url = new URL(rawUrl);
    // Read-only ceiling (#304): broker credentials inject toward SAFE methods
    // only; writes ride the outbox (#306). The error names that path (#308)
    // so a model can self-correct instead of retrying.
    const normalizedMethod = method.toUpperCase();
    if (
      !SAFE_METHODS.has(normalizedMethod) &&
      !opts.connectionAuth?.allowWrites &&
      !(
        normalizedMethod === "POST" &&
        isBrokerReadOnlyPost(opts.connectionAuth?.readOnlyPosts, url, body)
      )
    ) {
      throw new Error(
        `injected ${method.toUpperCase()} refused — this connection is read-only inside a fire. External writes are STAGED, never sent from handler code: ctx.vault.invoke({ command: 'outbox.stage', input: { kind, label, verb, target, artifact, request } }) parks the exact request for the owner's approval and the gateway executor performs the send (issues #304/#306)`
      );
    }
  };

  const abortableDelay = (ms: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      const onAbort = (): void => {
        cleanup();
        reject(new Error("aborted"));
      };
      const cleanup = (): void => {
        clearTimeout(t);
        dispatchCtx.abortSignal.removeEventListener("abort", onAbort);
      };
      dispatchCtx.abortSignal.addEventListener("abort", onAbort, {
        once: true,
      });
    });

  interface FetchWireResult {
    status: number;
    headers: Record<string, string>;
    text: string;
  }

  // Never auto-follow redirects: a cross-host Location would carry the
  // Authorization header past the pin; the handler sees the 3xx and follows.
  const fetchOnce = async (
    spec: FetchSpecWire,
    manualRedirects: boolean
  ): Promise<FetchWireResult> => {
    const response = await fetch(spec.url, {
      method: spec.method ?? "GET",
      ...(spec.headers ? { headers: spec.headers } : {}),
      ...(spec.body === undefined ? {} : { body: spec.body }),
      ...(manualRedirects ? { redirect: "manual" as const } : {}),
      signal: dispatchCtx.abortSignal,
    });
    const text = (await response.text()).slice(0, 2 * 1024 * 1024);
    return {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "",
        ...(response.headers.get("retry-after")
          ? { "retry-after": response.headers.get("retry-after")! }
          : {}),
      },
      text,
    };
  };

  /** Broker-injected fetches only (#304): 429/5xx → backoff; 401 → one forced
   *  refresh, then retry; 401 again or a 403 naming scopes → flip needs-auth
   *  (re-consent is an owner act). Non-injected fetches stay single-shot past
   *  the shared destination pin (#865). */
  const executeFetch = async (
    rawSpec: FetchSpecWire
  ): Promise<FetchWireResult> => {
    const substituted = await substituteSecrets(
      rawSpec,
      opts.connectionAuth?.values ?? {}
    );
    let { spec } = substituted;
    const { injected } = substituted;
    // Issue #865: the destination pin used to run ONLY when a placeholder was
    // substituted, so a placeholder-free template bypassed the https/host-pin
    // checks entirely — a blind egress rail. Every ctx.fetch rides the same
    // validation regardless of injection; secret/connection substitution is
    // untouched.
    assertFetchDestination(spec.url);
    if (!injected) return fetchOnce(spec, true);
    assertInjectable(spec.url, spec.method ?? "GET", spec.body);
    const auth = opts.connectionAuth!;
    const gated = (s: FetchSpecWire): Promise<FetchWireResult> =>
      auth.limit ? auth.limit(() => fetchOnce(s, true)) : fetchOnce(s, true);
    const retryDelays = opts.fetchRetryDelaysMs ?? [1000, 4000];
    let transientRetries = 0;
    let refreshed = false;
    const attempt = async (): Promise<FetchWireResult> => {
      const result = await gated(spec);
      if (result.status === 429 || result.status >= 500) {
        if (transientRetries >= retryDelays.length) return result;
        const planned = retryDelays[transientRetries]!;
        const retryAfterMs = Number(result.headers["retry-after"]) * 1000;
        await abortableDelay(
          Math.min(
            Number.isFinite(retryAfterMs)
              ? Math.max(retryAfterMs, planned)
              : planned,
            30_000
          )
        );
        transientRetries += 1;
        return attempt();
      }
      if (result.status === 401 && auth.refresh && !refreshed) {
        refreshed = true;
        const values = await auth.refresh();
        ({ spec } = await substituteSecrets(rawSpec, values));
        return attempt();
      }
      if (result.status === 401) {
        await auth
          .onAuthDead?.("external service rejected the credential (401)")
          .catch(() => undefined);
        return result;
      }
      if (
        result.status === 403 &&
        /insufficient.{0,4}(?:scope|permission)|invalid_scope/iu.test(
          result.text
        )
      ) {
        await auth
          .onAuthDead?.(
            "permission withdrawn upstream (403 insufficient scope) — reconnect with the scopes this connector needs"
          )
          .catch(() => undefined);
        return result;
      }
      return result;
    };
    return attempt();
  };

  const emit = opts.onRunEvent ?? noopRunEventSink;
  const audit: AuditState = {
    store: opts.runsStore,
    runId: opts.runId,
    automationId: opts.automationId,
    ordinal: 0,
    emit,
  };

  // Harness sessions are per-harness resume bindings BENEATH one canonical
  // conversation, so A → B → A never forks execution history.
  const slash = audit.automationId.indexOf("/");
  const appId = slash > 0 ? audit.automationId.slice(0, slash) : undefined;
  const execConversationId = audit.store.ensureAutomationConversation(
    audit.automationId,
    appId,
    opts.automationName,
    opts.harnessKind
  );
  const startedAt = opts.now === undefined ? Date.now() : Date.parse(opts.now);
  if (!Number.isFinite(startedAt))
    throw new Error("automation ctx.now must be a valid ISO instant");
  audit.store.insertTurn({
    turnId: audit.runId,
    conversationId: execConversationId,
    triggerKind: opts.triggerKind ?? "scheduled",
    ...(opts.triggerOrigin ? { triggerOrigin: opts.triggerOrigin } : {}),
    ...(opts.note ? { note: opts.note } : {}),
    ...(opts.parentRunId ? { parentTurnId: opts.parentRunId } : {}),
    startedAt,
  });
  // The trigger payload is `message_in` at ordinal 0, the shape a chat turn
  // records (#190); trace items start at 1.
  if (opts.input !== undefined) {
    audit.store.insertMessageIn({
      turnId: audit.runId,
      role: "user",
      text: truncateForAudit(opts.input) ?? "",
      startedAt,
    });
    audit.ordinal = 1;
  }
  if (opts.failoverNotice) {
    const at = Date.now();
    audit.store.insertItem({
      itemId: randomUUID(),
      turnId: audit.runId,
      ordinal: audit.ordinal,
      kind: "step",
      name: "notice:warn:failover",
      outputJson: JSON.stringify({ text: opts.failoverNotice }),
      ok: true,
      startedAt: at,
      endedAt: at,
      durationMs: 0,
    });
    audit.ordinal += 1;
  }
  try {
    emit({ type: "turn.start", turnId: audit.runId });
  } catch {
    /* swallow */
  }

  // The lane the parent is about to ask for, as a POOLING HINT; the worker
  // reports the lane it actually installed and the pool parks under that.
  const pool = automationWorkerPool();
  const sandboxKeyHint = JSON.stringify([
    opts.sandboxLane ?? "automation-handler",
    opts.sandboxReadRoots ? [...opts.sandboxReadRoots] : [],
    opts.sandboxRuntimeDir ?? null,
  ]);
  let installedKey = sandboxKeyHint;
  // Only a run that completed the protocol leaves a thread fit to serve the
  // next one; a timeout, a worker error or a non-zero exit kills it.
  let reusable = false;
  let timedOut = false;
  const worker = pool.acquire(sandboxKeyHint);
  const workerRequest = {
    handlerFile: opts.handlerFile,
    args: { automation: { id: opts.automationId } },
    now: new Date(startedAt).toISOString(),
    input: opts.input,
    ...(opts.sandboxLane ? { sandboxLane: opts.sandboxLane } : {}),
    ...(opts.sandboxReadRoots
      ? { sandboxReadRoots: [...opts.sandboxReadRoots] }
      : {}),
    ...(opts.sandboxRuntimeDir
      ? { sandboxRuntimeDir: opts.sandboxRuntimeDir }
      : {}),
  };

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      // A timed-out thread never goes back in the pool, whatever it posts
      // next: the grace period below ends in `terminate()`.
      timedOut = true;
      abortController.abort("timeout");
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- grandfathered pre-existing suppression (#247)
      worker.postMessage({ type: "abort", reason: "timeout" });
      setTimeout(() => {
        worker.terminate().catch(() => {});
      }, 2000);
    }, timeoutMs);
  }

  const send = (msg: unknown): void => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- grandfathered pre-existing suppression (#247)
    worker.postMessage(msg);
  };

  let connectorRunId: string | undefined;
  let connectorConnectionId: string | undefined;
  let connectorRunOpened = false;
  let connectorRunClosed = false;

  const invokeConnectorCommand = async (
    command: string,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    const reply = await handleVaultMessage(audit, opts.vault, "invoke", {
      command,
      input,
      purpose: "dpv:ServiceProvision",
    });
    if (!reply.ok) throw new Error(reply.error ?? `${command} failed`);
    const result = reply.result;
    if (!result || typeof result !== "object") return {};
    const outcome = result as Record<string, unknown>;
    return outcome.output && typeof outcome.output === "object"
      ? (outcome.output as Record<string, unknown>)
      : outcome;
  };

  const openConnectorRun = async (
    principal: string
  ): Promise<Record<string, unknown>> => {
    if (!opts.connector?.connectionId) {
      throw new Error(
        "declarative pull connector has no durable connection binding"
      );
    }
    if (connectorRunOpened) {
      throw new Error("connector run scope may be opened exactly once");
    }
    connectorRunOpened = true;
    const opened = await invokeConnectorCommand("sync.begin_run", {
      connection_id: opts.connector.connectionId,
      principal,
    });
    if (typeof opened.run_id === "string") connectorRunId = opened.run_id;
    if (typeof opened.connection_id === "string")
      connectorConnectionId = opened.connection_id;
    if (
      !opened.refused &&
      (connectorRunId === undefined || connectorConnectionId === undefined)
    ) {
      throw new Error("sync.begin_run did not return a connection-scoped run");
    }
    return opened;
  };

  const closeConnectorRun = async (
    ok: boolean,
    counts: { staged?: number; published?: number; skipped?: number } = {},
    error?: string
  ): Promise<void> => {
    if (!connectorRunId || connectorRunClosed) return;
    await invokeConnectorCommand("sync.finish_run", {
      run_id: connectorRunId,
      ok,
      ...counts,
      ...(error ? { error } : {}),
    });
    connectorRunClosed = true;
  };

  const publishPullResult = async (
    pull: Record<string, unknown>
  ): Promise<{ summary?: string; output: Record<string, unknown> }> => {
    if (!connectorRunId || !connectorConnectionId || !opts.connector) {
      throw new Error(
        "pull connector returned rows without an open connection-scoped run"
      );
    }
    const rows = Array.isArray(pull.rows) ? pull.rows : [];
    let staged = 0;
    let published = 0;
    try {
      const chunks = Array.from(
        { length: Math.ceil(rows.length / 500) },
        (_, index) => rows.slice(index * 500, (index + 1) * 500)
      );
      await applyInOrder(chunks, async (chunk) => {
        const outcome = await invokeConnectorCommand("sync.stage_rows", {
          connection_id: connectorConnectionId,
          rows: chunk,
        });
        staged += chunk.length;
        const counts = outcome.published as
          | { created?: number; updated?: number }
          | undefined;
        published += (counts?.created ?? 0) + (counts?.updated ?? 0);
      });
      const cursors = Array.isArray(pull.cursors) ? pull.cursors : [];
      await applyInOrder(cursors, async (entry) => {
        if (!Array.isArray(entry) || typeof entry[0] !== "string") {
          throw new Error("pull connector returned an invalid cursor update");
        }
        await invokeConnectorCommand("sync.set_cursor", {
          connection_id: connectorConnectionId,
          key: entry[0],
          value: entry[1],
        });
      });
      await closeConnectorRun(true, { staged, published });
      return {
        ...(typeof pull.summary === "string" ? { summary: pull.summary } : {}),
        output: { staged, published },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await closeConnectorRun(false, { staged, published }, message).catch(
        () => undefined
      );
      throw error;
    }
  };

  return await new Promise<HandlerOutcome>((resolve) => {
    const state: PendingState = { resolve, resolved: false };

    const finish = (initialOutcome: HandlerOutcome): void => {
      let outcome = initialOutcome;
      if (state.resolved) return;
      state.resolved = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      // Backstop scrub: nothing a run RECORDS may carry a secret (#293).
      if (resolvedSecretValues.size > 0) {
        if (outcome.error) outcome.error = scrub(outcome.error);
        if (outcome.summary) outcome.summary = scrub(outcome.summary);
        if (outcome.output !== undefined) {
          outcome.output = JSON.parse(
            scrub(JSON.stringify(outcome.output))
          ) as unknown;
        }
        if (outcome.value !== undefined) {
          outcome.value = JSON.parse(
            scrub(JSON.stringify(outcome.value))
          ) as unknown;
        }
        outcome.logs = outcome.logs.map((l) => ({ ...l, msg: scrub(l.msg) }));
        for (const entry of persistedEntries) entry.msg = scrub(entry.msg);
      }
      const settleTurn = (finalizationError?: string): void => {
        audit.store.finishTurn({
          turnId: audit.runId,
          endedAt: Date.now(),
          ok: outcome.ok,
          // A finalization failure is the host's: recorded on the turn, but it
          // never rewrites the handler's own error.
          ...(outcome.error
            ? { error: outcome.error }
            : finalizationError
              ? { error: `turn finalization failed: ${finalizationError}` }
              : {}),
          ...(outcome.summary ? { summary: outcome.summary } : {}),
          ...(outcome.output === undefined
            ? {}
            : { outputJson: truncateForAudit(outcome.output) ?? "" }),
        });
      };
      try {
        audit.store.runInTransaction(() => {
          settleTurn();
          opts.finalizeTurn?.(
            audit.store,
            execConversationId,
            audit.runId,
            outcome.ok
          );
        });
      } catch (error) {
        // The rollback took `finishTurn` with it, so without this second,
        // non-transactional write the turn stays `running` forever.
        const finalizationError =
          error instanceof Error ? error.message : String(error);
        try {
          const at = Date.now();
          audit.store.insertItem({
            itemId: randomUUID(),
            turnId: audit.runId,
            ordinal: audit.ordinal,
            kind: "step",
            name: "notice:error:finalization",
            outputJson: JSON.stringify({
              text: `Turn finalization failed after the handler completed: ${finalizationError}`,
            }),
            ok: false,
            error: finalizationError,
            startedAt: at,
            endedAt: at,
            durationMs: 0,
          });
          audit.ordinal += 1;
          settleTurn(finalizationError);
        } catch (settleError) {
          outcome = {
            ...outcome,
            ok: false,
            error:
              `turn finalization failed: ${finalizationError}; ` +
              `settling the turn also failed: ` +
              `${settleError instanceof Error ? settleError.message : String(settleError)}`,
          };
        }
      }
      try {
        emit({
          type: "turn.end",
          turnId: audit.runId,
          ok: outcome.ok,
          ...(outcome.error ? { error: outcome.error } : {}),
        });
      } catch {
        /* swallow */
      }
      applyRetention(audit.store, audit.automationId, opts.history);
      abortController.abort();
      if (reusable && !timedOut) pool.release(worker, installedKey);
      else pool.retire(worker);
      if (persistedEntries.length > 0)
        void appendLogs(opts.automationDir, persistedEntries);
      // oxlint-disable-next-line promise/no-multiple-resolved -- grandfathered pre-existing suppression (#247)
      resolve(outcome);
    };

    worker.on("message", (msg: WorkerToParentMessage) => {
      if (msg.type === "delegate") {
        if (opts.connector) {
          send({
            type: "delegate-reply",
            id: msg.id,
            ok: false,
            error:
              "ctx.delegate is forbidden in connector handlers — connectors are deterministic published code; repair happens at authoring time (issue #290)",
          });
          return;
        }
        delegateCalls++;
        void handleDelegateMessage(
          audit,
          dispatchCtx,
          opts.delegateDispatcher,
          msg.prompt,
          msg.json,
          msg.harness,
          msg.model,
          msg.configPins,
          msg.content,
          opts.vault
        ).then((reply) => {
          send({ type: "delegate-reply", id: msg.id, ...reply });
        });
        return;
      }
      if (msg.type === "fetch") {
        // Connector-only (#293): the recorded spec keeps its placeholders, and
        // the response is never journaled.
        if (!opts.connector) {
          send({
            type: "fetch-reply",
            id: msg.id,
            ok: false,
            error: "ctx.fetch is connector-only",
          });
          return;
        }
        logs.push({
          level: "info",
          msg: `fetch ${msg.spec.method ?? "GET"} ${msg.spec.url}`,
        });
        const request = executeFetch(msg.spec);
        void request
          .then((result) => {
            send({ type: "fetch-reply", id: msg.id, ok: true, result });
          })
          .catch((error: unknown) => {
            send({
              type: "fetch-reply",
              id: msg.id,
              ok: false,
              error: scrub(
                error instanceof Error ? error.message : String(error)
              ),
            });
          });
        return;
      }
      if (msg.type === "connector-open") {
        if (!opts.connector) {
          send({
            type: "connector-open-reply",
            id: msg.id,
            ok: false,
            error: "connection-scoped runs are connector-only",
          });
          return;
        }
        void openConnectorRun(msg.principal)
          .then((result) => {
            send({
              type: "connector-open-reply",
              id: msg.id,
              ok: true,
              result,
            });
          })
          .catch((error: unknown) => {
            send({
              type: "connector-open-reply",
              id: msg.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        return;
      }
      if (msg.type === "state") {
        send({
          type: "state-reply",
          id: msg.id,
          ...handleStateMessage(audit, msg.method, msg.key, msg.value),
        });
        return;
      }
      if (msg.type === "runs") {
        send({
          type: "runs-reply",
          id: msg.id,
          ...handleRunsMessage(audit, msg.method, msg.filter),
        });
        return;
      }
      if (msg.type === "vault") {
        const payload = bindConnectorVaultPayload(
          msg.op,
          msg.payload,
          opts.connector?.connectionId
        );
        void handleVaultMessage(audit, opts.vault, msg.op, payload).then(
          (reply) => {
            send({ type: "vault-reply", id: msg.id, ...reply });
          }
        );
        return;
      }
      if (msg.type === "log") {
        logs.push({ level: msg.level, msg: msg.msg });
        persistedEntries.push({
          ts: Date.now(),
          level: msg.level,
          msg: msg.msg,
          source: "action",
          handler: handlerName,
        });
        return;
      }
      if (msg.type === "result") {
        reusable = msg.retire !== true;
        if (msg.sandboxKey) installedKey = msg.sandboxKey;
        void (async () => {
          try {
            let rawValue = msg.value;
            if (!msg.ok) {
              // Best-effort: a close failure must not replace the real error.
              await closeConnectorRun(
                false,
                {},
                msg.error ?? "pull connector failed before returning rows"
              ).catch(() => undefined);
            }
            if (
              msg.ok &&
              rawValue &&
              typeof rawValue === "object" &&
              "__centraidPull" in rawValue
            ) {
              const published = await publishPullResult(
                (rawValue as { __centraidPull: Record<string, unknown> })
                  .__centraidPull
              );
              rawValue = {
                ...(published.summary ? { summary: published.summary } : {}),
                output: published.output,
              };
            }
            const envelope = msg.ok
              ? extractReturnEnvelope(rawValue)
              : ({ value: rawValue } satisfies HandlerReturnEnvelope);
            let outcomeError = msg.error;
            let outcomeOk = msg.ok;
            if (msg.ok && opts.outputSchema && envelope.output !== undefined) {
              const schemaErr = validateOutputAgainstSchema(
                opts.outputSchema,
                envelope.output
              );
              if (schemaErr) {
                outcomeOk = false;
                outcomeError = `outputSchema validation failed: ${schemaErr}`;
              }
            }
            if (!outcomeOk && outcomeError) {
              persistedEntries.push({
                ts: Date.now(),
                level: "error",
                msg: `automation handler failed: ${outcomeError}`,
                source: "action",
                handler: handlerName,
              });
            }
            finish({
              ok: outcomeOk,
              value: envelope.value,
              ...(envelope.summary === undefined
                ? {}
                : { summary: envelope.summary }),
              ...(envelope.output === undefined
                ? {}
                : { output: envelope.output }),
              ...(outcomeError === undefined ? {} : { error: outcomeError }),
              logs,
              toolBatches,
              delegateCalls,
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            await closeConnectorRun(false, {}, message).catch(() => undefined);
            finish({
              ok: false,
              error: message,
              logs,
              toolBatches,
              delegateCalls,
            });
          }
        })();
      }
    });

    worker.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      persistedEntries.push({
        ts: Date.now(),
        level: "error",
        msg: `worker error: ${message}`,
        source: "action",
        handler: handlerName,
      });
      void closeConnectorRun(false, {}, message)
        .catch(() => undefined)
        .finally(() =>
          finish({
            ok: false,
            error: message,
            logs,
            toolBatches,
            delegateCalls,
          })
        );
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        persistedEntries.push({
          ts: Date.now(),
          level: "error",
          msg: `worker exited with code ${code}`,
          source: "action",
          handler: handlerName,
        });
        const error = `worker exited with code ${code}`;
        void closeConnectorRun(false, {}, error)
          .catch(() => undefined)
          .finally(() =>
            finish({ ok: false, error, logs, toolBatches, delegateCalls })
          );
      }
    });

    send({ type: "run", request: workerRequest });
  });
}
