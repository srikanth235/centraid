// governance: allow-repo-hygiene file-size-limit the parent-side handler orchestrator is one message-pump — delegate/fetch/state/vault dispatch plus the #293 secret and #304 connection injection all share the one worker-boundary protocol, so splitting scatters the wire contract
/**
 * Parent-side orchestrator for automation handlers.
 *
 * Issue #98: an automation is a self-contained unit that lives inside an
 * app folder (`<appCodeDir>/automations/<id>/`). The generated handler is a
 * single `handler.js` in that directory, executed in a worker thread
 * that exposes `ctx.delegate` / `ctx.fetch` / `ctx.vault` / `ctx.state` /
 * `ctx.runs`. Cross-run persistence is `ctx.state` (the `automation_state`
 * KV keyed by the automation id).
 *
 *   - Worker entry is `worker/runner.js`.
 *   - The parent supplies `delegateDispatcher` (the one billed rail — a bounded
 *     model turn); `ctx.vault` / `ctx.fetch` / `ctx.state` / `ctx.runs` are
 *     serviced here, in-process, against the vault bridge and SQLite.
 *   - Every ctx surface call becomes one `run_nodes` audit row. There is no
 *     runtime retry — a failed call rejects the handler Promise.
 *   - Retention runs at end-of-run per `manifest.history.keep`.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  appendLogs,
  WorkerPool,
  workerPoolSizeFromEnv,
  workerResourceLimitsFromEnv,
} from "@centraid/app-engine";
import type {
  LogEntry,
  ConversationStore,
  AutomationTriggerKind,
  AutomationTriggerOrigin,
  TurnStreamEvent,
  AutomationTurnStreamEvent,
  VaultBridge,
  VaultOp,
} from "@centraid/app-engine";

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
  // `here` is the dir of this module (`src/handler` → `dist/handler` once
  // built); the worker runner lives one level up under `worker/`.
  const here = import.meta.dirname;
  const jsPath = path.join(here, "..", "worker", "runner.js");
  if (existsSync(jsPath)) return jsPath;
  // Running tests via tsx from src/ where .js isn't emitted — fall back to
  // the .ts source. tsx propagates its loader to spawned Workers via
  // NODE_OPTIONS, so this works under `tsx --test`.
  return path.join(here, "..", "worker", "runner.ts");
}

const WORKER_FILE = resolveWorkerFile();
let automationWorkerPoolInstance: WorkerPool | undefined;

/** Resolve only after gateway boot publishes its storage-aware profile. */
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

/**
 * One resolved vault derivative riding beside a `ctx.delegate` prompt (issue
 * #299): already consent-checked and receipted by the vault bridge. `base64`
 * for binary variants (thumb/preview), `text` for the text variant.
 */
export interface DelegateAttachment {
  readonly name: string;
  readonly mediaType: string;
  readonly base64?: string;
  readonly text?: string;
}

export interface DelegateCall {
  readonly prompt: string;
  readonly json?: unknown;
  /** Optional per-call harness override; never silently fails over. */
  readonly harness?: string;
  readonly model?: string;
  readonly configPins?: Readonly<Record<string, string>>;
  /** Vault derivatives to hand the model with the prompt (issue #299). */
  readonly attachments?: readonly DelegateAttachment[];
  /**
   * Token-stream sink (issue #158, Phase 2). When a harness routes
   * `ctx.delegate` through the streaming turn plane, each `TurnStreamEvent`
   * is forwarded here; the harness wraps it as an `item.delta` on the owning
   * delegate item. Absent for dispatchers still on the collect-on-exit path.
   */
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
  /** Id of the automation app (its directory name). */
  automationId: string;
  /**
   * The automation's display name (manifest `name`), recorded on the
   * execution conversation's `title` so a later-deleted automation's runs
   * still carry their last-known name instead of just the raw ref.
   */
  automationName?: string;
  /** The automation app directory — handler logs are written here. */
  automationDir: string;
  /** Absolute path to the generated `handler.js`. */
  handlerFile: string;
  runId: string;
  /** ISO fire-start instant fixed by the caller; defaults to handler admission time. */
  now?: string;
  delegateDispatcher: DelegateDispatcher;
  /** Per-app conversation-ledger store for audit + ctx.state + ctx.runs. */
  runsStore: ConversationStore;
  /**
   * Host-owned binding/watermark update. Runs synchronously in the exact
   * transaction that settles this handler turn.
   */
  finalizeTurn?: (
    store: ConversationStore,
    conversationId: string,
    turnId: string,
    ok: boolean
  ) => void;
  /** Fixed harness owner for this automation conversation. */
  harnessKind?: string;
  /** Effective model when a usage event omits its model id. */
  model?: string;
  /**
   * Host-injected `ctx.vault` executor, bound to this automation's enrolled
   * `consent.agent` credential (duaility §12). Absent → every `ctx.vault` call
   * fails closed with `VAULT_UNAVAILABLE`.
   */
  vault?: VaultBridge;
  /**
   * Live turn-stream sink. Receives `turn.start` / `item.start` /
   * `item.end` / `turn.end` as the turn unfolds, alongside `onLog`. Wired by
   * the host to its `runId`-keyed bus; omit for a non-streamed fire (the
   * durable ledger still records everything).
   */
  onRunEvent?: (ev: AutomationTurnStreamEvent) => void;
  triggerKind?: AutomationTriggerKind;
  /** Source that fired the run (`cron` / `webhook` / `manual`). */
  triggerOrigin?: AutomationTriggerOrigin;
  /** Human-readable trigger-gap/cursor note stored on the turn. */
  note?: string;
  /** Durable reader-facing boundary notice when this is a failover attempt. */
  failoverNotice?: string;
  input?: unknown;
  parentRunId?: string;
  outputSchema?: OutputSchema;
  history?: HistoryConfig;
  timeoutMs?: number;
  /**
   * Connector confinement (issue #290 phase 4). When present, this run is a
   * published connector: `ctx.delegate` is forbidden entirely (agents write
   * code, not data — the LLM appears at authoring/repair time, never in the
   * per-sync loop), and `ctx.fetch` is the connector's only external rail.
   *
   * `secrets` (issue #293) is the allowlist for `{{secret:…}}` placeholders
   * in `ctx.fetch` — `locker:<item_id>:<column>` refs the manifest declared.
   */
  connector?: {
    /** Manifest-owned identity; handler code cannot override either field. */
    readonly kind: string;
    readonly label: string;
    readonly secrets?: readonly string[];
    /**
     * Durable owner-selected connection binding (#524). The parent injects
     * this id into sync.begin_run/sync.stage_rows after the worker boundary,
     * so published handler code cannot accidentally fork a label-based
     * shadow connection when the owner renamed or custom-labelled the row.
     */
    readonly connectionId?: string;
  };
  /**
   * Host-injected secret resolution for connector `ctx.fetch` (issue #293):
   * ref → plaintext, backed by the automation agent's `reveal` grant. The
   * value substitutes into the request at THIS side of the worker boundary
   * and is scrubbed from every recorded string as a backstop.
   */
  resolveSecret?: (ref: string) => Promise<string>;
  /**
   * Broker-resolved connection credential (issue #304): the values behind
   * `{{connection:…}}` placeholders in `ctx.fetch`, plus the host pin they
   * may be injected toward. Provided by the gateway's connection broker when
   * the connector's connection carries an `oauth2`/`api_key` credential;
   * absent on the harness-ambient lane.
   */
  connectionAuth?: ConnectionAuth;
  /**
   * Transient-failure backoff schedule for INJECTED fetches (429/5xx), in
   * ms. Tests shrink it; the default is [1000, 4000].
   */
  fetchRetryDelaysMs?: readonly number[];
}

/**
 * A broker-resolved connection credential riding one fire (issue #304).
 * The token itself never crosses the worker boundary: `values` substitute
 * into the request parent-side (like `{{secret:…}}`), `allowedHosts` is the
 * anti-exfiltration pin (injection refuses any other destination), and the
 * three hooks are how the fetch taxonomy talks back to the broker.
 */
export interface ConnectionAuth {
  /** Placeholder name → plaintext, e.g. `{ access_token: 'ya29…' }`. */
  readonly values: Readonly<Record<string, string>>;
  /**
   * Hosts the credential may be injected toward: exact hostnames or
   * `*.suffix` wildcards (`*.googleapis.com`).
   */
  readonly allowedHosts: readonly string[];
  /**
   * Force-refresh after a 401 — resolves replacement `values`. Rejects when
   * the credential is dead (the broker has already flipped needs-auth).
   * Absent for `api_key` credentials (nothing to refresh).
   */
  readonly refresh?: () => Promise<Readonly<Record<string, string>>>;
  /**
   * The credential is dead upstream (401 after refresh, scope withdrawn):
   * flip the connection to needs-auth with an owner-readable reason.
   */
  readonly onAuthDead?: (reason: string) => Promise<void>;
  /**
   * Per-connection rate gate every injected request passes through, shared
   * across concurrent fires on the same connection.
   */
  readonly limit?: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * Whether this credential may be injected toward MUTATING methods (issue
   * #304 phase 5). Default (unset) = read-only: a POST/PUT/PATCH/DELETE
   * injected request is refused. Connector fires never set this — external
   * writes ride `outbox.stage` → the gateway executor's `allowWrites` lane
   * (issue #306), never raw ctx.fetch.
   */
  readonly allowWrites?: boolean;
  /**
   * Exact provider endpoints whose APIs model read operations as POST.
   * Broker-owned policy only: handler code cannot grant itself a target.
   */
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
    // Strip comments and strings before looking for operation keywords.
    // Erring closed here is preferable to letting a connector smuggle a
    // GraphQL mutation through the read-only POST exception.
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
  /**
   * The fire ended BEFORE the handler ran, on owner-chosen or already-surfaced
   * state — a paused / needs-auth connection, an unavailable secret, a broker
   * refusal. Not a failure of the automation: hosts must not report a skip as
   * one (it would spam a fresh high-severity notice every cron tick for as
   * long as the owner leaves the connection paused — #647 review).
   */
  skipped?: boolean;
  /**
   * Set when the skip was the ENRICHMENT TIER GATE refusing the fire
   * (`fire.ts`, decision S9). Structured rather than left for a host to
   * pattern-match out of `error`, because the host has to name the domain in
   * a member-facing surface and point at the control that changes it — and a
   * privacy refusal that only exists as prose in a log is the silent failure
   * the gate was supposed to end.
   *
   * Absent on every other skip: a paused connection is already carried by its
   * own decision row and must not be re-announced.
   */
  enrichRefusal?: {
    domain: string;
    /** The enricher's capability id (`faces`, `captions`, …). */
    capability: string;
    /** The tier in force, or `undefined` when it could not be read at all. */
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
  | { type: "result"; ok: boolean; value?: unknown; error?: string };

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Handler actions mutate one run's durable state and must remain in author
 * order. Independent work belongs behind an explicit concurrent helper.
 */
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

  // No tool rail exists any more — the field stays for the run record shape,
  // pinned at 0 (a fire never dispatches a tool batch).
  const toolBatches = 0;
  let delegateCalls = 0;

  // Secret values resolved for ctx.fetch this run (issue #293). Substitution
  // is transport-level; this set powers the backstop scrub over everything
  // the run RECORDS — logs, summary, output, errors.
  const resolvedSecretValues = new Set<string>();
  const scrub = (text: string): string => {
    let out = text;
    for (const value of resolvedSecretValues) {
      // Both the raw form and its JSON-escaped form — a secret embedded in
      // stringified output would otherwise slip the net.
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
      // Broker-injected connection values (issue #304): the placeholder
      // names what the credential carries (`access_token` / `api_key`);
      // an unknown name — or no broker credential at all — is a handler
      // bug surfaced as an error, never an empty substitution.
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

  // The anti-exfiltration pin (issue #304 decision 2): an injected request
  // may only point where the CONNECTION says its credential may go. Exact
  // hostnames or `*.suffix` wildcards; https only, loopback excepted (tests
  // and the desktop's local bridges).
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
  const assertInjectable = (
    rawUrl: string,
    method: string,
    body?: string
  ): void => {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && !isLoopback(url)) {
      throw new Error(
        `injected fetch refuses non-https destination ${url.hostname} (issue #304)`
      );
    }
    if (!hostAllowed(url)) {
      throw new Error(
        `host "${url.hostname}" is outside this connection's allowed_hosts — the credential is pinned to ${(opts.connectionAuth?.allowedHosts ?? []).join(", ")} (issue #304)`
      );
    }
    // Read-only ceiling (issue #304 phase 5): a broker credential injects
    // toward SAFE methods only inside a fire. The write half shipped as the
    // outbox (issue #306) — the error names the actual path (issue #308 B1)
    // so a model that hits the ceiling can self-correct instead of retrying.
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

  // One HTTP round trip. Injected requests never auto-follow redirects — a
  // cross-host Location would carry the Authorization header somewhere the
  // pin never approved; the handler sees the 3xx and follows deliberately.
  const fetchOnce = async (
    spec: FetchSpecWire,
    injected: boolean
  ): Promise<FetchWireResult> => {
    const response = await fetch(spec.url, {
      method: spec.method ?? "GET",
      ...(spec.headers ? { headers: spec.headers } : {}),
      ...(spec.body === undefined ? {} : { body: spec.body }),
      ...(injected ? { redirect: "manual" as const } : {}),
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

  /**
   * The failure taxonomy for broker-injected fetches (issue #304 decision 5):
   * 429/5xx → bounded backoff retry; 401 → one forced token refresh, then
   * retry; 401 again (or with nothing to refresh) → the credential is dead,
   * flip needs-auth and hand the response back; 403 that names scopes →
   * same flip (re-consent is an owner act, not a retry). Non-injected
   * fetches keep the raw single-shot behavior — their errors belong to the
   * handler.
   */
  const executeFetch = async (
    rawSpec: FetchSpecWire
  ): Promise<FetchWireResult> => {
    const substituted = await substituteSecrets(
      rawSpec,
      opts.connectionAuth?.values ?? {}
    );
    let { spec } = substituted;
    const { injected } = substituted;
    if (!injected) return fetchOnce(spec, false);
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
        // A refusal here means the broker already flipped needs-auth — the
        // thrown message is what the run records.
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

  // Every fire appends to the automation's stable canonical conversation.
  // Harness sessions are per-harness resume bindings beneath this identity,
  // so A → B → A never forks execution history.
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
  // The trigger payload is the inbound `message_in` item (ordinal 0) — the
  // same shape a chat turn records (issue #190, criterion 4). Trace items
  // (tool/delegate) then start at ordinal 1.
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
  // `turn.start` opens the live stream; a viewer that joins later replays it
  // from the ledger instead. Guarded — a wedged sink must not fail the run.
  try {
    emit({ type: "turn.start", turnId: audit.runId });
  } catch {
    /* swallow */
  }

  const worker = automationWorkerPool().acquire();
  const workerRequest = {
    handlerFile: opts.handlerFile,
    args: { automation: { id: opts.automationId } },
    now: new Date(startedAt).toISOString(),
    input: opts.input,
  };

  let timeoutHandle: NodeJS.Timeout | undefined;
  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      abortController.abort("timeout");
      // eslint-disable-next-line unicorn/require-post-message-target-origin -- grandfathered pre-existing suppression (#247)
      worker.postMessage({ type: "abort", reason: "timeout" });
      setTimeout(() => {
        worker.terminate().catch(() => {});
      }, 2000);
    }, timeoutMs);
  }

  const send = (msg: unknown): void => {
    // eslint-disable-next-line unicorn/require-post-message-target-origin -- grandfathered pre-existing suppression (#247)
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
      // Backstop scrub (issue #293): nothing a run RECORDS may carry a
      // resolved secret — transport injection is the mechanism, this is the
      // net under it.
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
          // A finalization failure is the host's, not the handler's. It is
          // recorded on the turn so it is visible, but it never rewrites a
          // handler outcome — the handler's own error still wins the column.
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
        // The rollback took the `finishTurn` with it, so without a second,
        // non-transactional write this turn would stay `running` forever while
        // the handler had in fact completed. Binding/watermark finalization is
        // what failed; the run itself is settled honestly.
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
          // The ledger itself is unreachable — there is nothing durable left
          // to write, so surface it on the returned outcome instead.
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
      worker.removeAllListeners();
      worker.terminate().catch(() => {});
      if (persistedEntries.length > 0)
        void appendLogs(opts.automationDir, persistedEntries);
      // eslint-disable-next-line promise/no-multiple-resolved -- grandfathered pre-existing suppression (#247)
      resolve(outcome);
    };

    worker.on("message", (msg: WorkerToParentMessage) => {
      if (msg.type === "delegate") {
        // Connectors are deterministic code — no LLM turn ever runs inside
        // a sync loop (issue #290: agents write code, not data).
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
        // Transport-level secret injection (issue #293): connector-only —
        // the recorded spec keeps its placeholders; substitution happens
        // here, past the worker boundary, and the response rides back to
        // the handler without ever being journaled.
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
        void (async () => {
          try {
            let rawValue = msg.value;
            if (!msg.ok) {
              // Finishing the bookkeeping run is best-effort on an already
              // failed handler path. A vault close failure must not replace
              // the provider/handler error that actually caused the run.
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
      // @types/node 26 types this callback's argument as `unknown` — a worker
      // can reject with any value, not only an Error.
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

    // The acquired spare has already paid thread/module boot. It remains
    // single-use: this kickoff is its only handler, and finish() terminates it.
    send({ type: "run", request: workerRequest });
  });
}
