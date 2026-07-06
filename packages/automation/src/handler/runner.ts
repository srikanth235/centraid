/**
 * Parent-side orchestrator for automation handlers.
 *
 * Issue #98: an automation is a self-contained unit that lives inside an
 * app folder (`<appCodeDir>/automations/<id>/`). The generated handler is a
 * single `handler.js` in that directory, executed in a worker thread
 * that exposes `ctx.tool` / `ctx.agent` / `ctx.state` / `ctx.runs`.
 * Cross-run persistence is `ctx.state` (the `automation_state` KV keyed
 * by the automation id).
 *
 *   - Worker entry is `worker/runner.js`.
 *   - The parent supplies `toolDispatcher` and `agentDispatcher`.
 *   - Tool calls arrive in batches; each call becomes one `run_nodes`
 *     audit row. There is no runtime retry — a failed `ctx.tool`
 *     rejects the handler Promise (see `ctx.ts`).
 *   - Every ctx surface call lands in the activity DB's run-audit
 *     tables. Retention runs at end-of-run per `manifest.history.keep`.
 */

import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  appendLogs,
  type LogEntry,
  type ConversationStore,
  type AutomationTriggerKind,
  type AutomationTriggerOrigin,
  type TurnStreamEvent,
  type RunStreamEvent,
  type VaultBridge,
  type VaultOp,
} from '@centraid/app-engine';
import type { HistoryConfig, OutputSchema } from '../manifest/manifest.js';
import { validateOutputAgainstSchema } from '../manifest/manifest-output.js';
import {
  applyRetention,
  extractReturnEnvelope,
  noopRunEventSink,
  truncateForAudit,
  type HandlerReturnEnvelope,
} from './audit.js';
import {
  dispatchToolBatch,
  handleAgentMessage,
  handleRunsMessage,
  handleStateMessage,
  handleVaultMessage,
  type AuditState,
  type ToolCallWire,
} from './ctx.js';

function resolveWorkerFile(): string {
  // `here` is the dir of this module (`src/handler` → `dist/handler` once
  // built); the worker runner lives one level up under `worker/`.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const jsPath = path.join(here, '..', 'worker', 'runner.js');
  if (existsSync(jsPath)) return jsPath;
  // Running tests via tsx from src/ where .js isn't emitted — fall back to
  // the .ts source. tsx propagates its loader to spawned Workers via
  // NODE_OPTIONS, so this works under `tsx --test`.
  return path.join(here, '..', 'worker', 'runner.ts');
}

const WORKER_FILE = resolveWorkerFile();

export interface ToolCall {
  readonly name: string;
  readonly args: unknown;
}

export interface ToolResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  /**
   * Real per-tool start/finish epoch-ms, when the dispatcher can observe them
   * (issue #158, Phase 3 — from the mock server's onToolStart/onToolResults).
   * When present, the audit node uses these instead of the batch-wide window,
   * so a tool's recorded duration excludes CLI spawn/teardown overhead.
   */
  startedAt?: number;
  endedAt?: number;
}

export type ToolDispatcher = (
  calls: readonly ToolCall[],
  ctx: DispatchContext,
) => Promise<ToolResult[]>;

/**
 * One resolved vault derivative riding beside a `ctx.agent` prompt (issue
 * #299): already consent-checked and receipted by the vault bridge. `base64`
 * for binary variants (thumb/preview), `text` for the text variant.
 */
export interface AgentAttachment {
  readonly name: string;
  readonly mediaType: string;
  readonly base64?: string;
  readonly text?: string;
}

export interface AgentCall {
  readonly prompt: string;
  readonly json?: unknown;
  /** Vault derivatives to hand the model with the prompt (issue #299). */
  readonly attachments?: readonly AgentAttachment[];
  /**
   * Token-stream sink (issue #158, Phase 2). When a runner routes
   * `ctx.agent` through its streaming chat adapter, each `TurnStreamEvent`
   * is forwarded here; the runner wraps it as a `node.delta` on the owning
   * agent node. Absent for runners still on the collect-on-exit path.
   */
  readonly onEvent?: (ev: TurnStreamEvent) => void;
}

export type AgentDispatcher = (call: AgentCall, ctx: DispatchContext) => Promise<unknown>;

export interface DispatchContext {
  readonly runId: string;
  readonly automationId: string;
  readonly abortSignal: AbortSignal;
}

export interface RunHandlerOptions {
  /** Id of the automation app (its directory name). */
  automationId: string;
  /** The automation app directory — handler logs are written here. */
  automationDir: string;
  /** Absolute path to the generated `handler.js`. */
  handlerFile: string;
  runId: string;
  toolDispatcher: ToolDispatcher;
  agentDispatcher: AgentDispatcher;
  /** Per-app conversation-ledger store for audit + ctx.state + ctx.runs. */
  runsStore: ConversationStore;
  /**
   * Host-injected `ctx.vault` executor, bound to this automation's enrolled
   * `agent.agent` credential (duaility §12). Absent → every `ctx.vault` call
   * fails closed with `VAULT_UNAVAILABLE`.
   */
  vault?: VaultBridge;
  /**
   * Live run-stream sink (issue #158). Receives `run.start` / `node.start` /
   * `node.end` / `run.end` as the run unfolds, alongside `onLog`. Wired by
   * the host to its `runId`-keyed bus; omit for a non-streamed fire (the
   * durable ledger still records everything).
   */
  onRunEvent?: (ev: RunStreamEvent) => void;
  triggerKind?: AutomationTriggerKind;
  /** Source that fired the run (`cron` / `webhook` / `manual`). */
  triggerOrigin?: AutomationTriggerOrigin;
  input?: unknown;
  parentRunId?: string;
  outputSchema?: OutputSchema;
  history?: HistoryConfig;
  timeoutMs?: number;
  /**
   * Connector confinement (issue #290 phase 4). When present, this run is a
   * published connector: `tools` is a HARD per-call allowlist over ctx.tool
   * (requires-as-allowlist — the confused-deputy defense: connector code
   * holds broad ambient harness tokens AND vault access, so confinement
   * happens at the one chokepoint the vault side owns), and `ctx.agent` is
   * forbidden entirely (agents write code, not data — the LLM appears at
   * authoring/repair time, never in the per-sync loop).
   *
   * `secrets` (issue #293) is the allowlist for `{{secret:…}}` placeholders
   * in `ctx.fetch` — `locker:<item_id>:<column>` refs the manifest declared.
   */
  connector?: { readonly tools: readonly string[]; readonly secrets?: readonly string[] };
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
}

export interface HandlerOutcome {
  ok: boolean;
  value?: unknown;
  summary?: string;
  output?: unknown;
  error?: string;
  logs: Array<{ level: 'info' | 'warn' | 'error'; msg: string }>;
  toolBatches: number;
  agentCalls: number;
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
}

type WorkerToParentMessage =
  | { type: 'tool-batch'; id: number; calls: ToolCallWire[] }
  | {
      type: 'agent';
      id: number;
      prompt: string;
      json?: unknown;
      content?: { contentId: string; variant: string; maxBytes?: number }[];
    }
  | { type: 'fetch'; id: number; spec: FetchSpecWire }
  | { type: 'state'; id: number; method: 'get' | 'set' | 'delete'; key: string; value?: unknown }
  | {
      type: 'runs';
      id: number;
      method: 'last' | 'list';
      filter: { automationId?: string; status?: 'ok' | 'error'; since?: number; limit?: number };
    }
  | { type: 'vault'; id: number; op: VaultOp; payload: Record<string, unknown> }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; msg: string }
  | { type: 'result'; ok: boolean; value?: unknown; error?: string };

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function runHandler(opts: RunHandlerOptions): Promise<HandlerOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const logs: HandlerOutcome['logs'] = [];
  const persistedEntries: LogEntry[] = [];
  const handlerName = path.basename(opts.handlerFile).replace(/\.js$/, '');

  const abortController = new AbortController();
  const dispatchCtx: DispatchContext = {
    runId: opts.runId,
    automationId: opts.automationId,
    abortSignal: abortController.signal,
  };

  let toolBatches = 0;
  let agentCalls = 0;

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
        if (needle) out = out.replaceAll(needle, '«secret»');
      }
    }
    return out;
  };
  const SECRET_REF_RE = /\{\{secret:([^}]+)\}\}/g;
  const CONNECTION_REF_RE = /\{\{connection:([a-z_]+)\}\}/g;
  const substituteSecrets = async (
    spec: FetchSpecWire,
    connectionValues: Readonly<Record<string, string>>,
  ): Promise<{ spec: FetchSpecWire; injected: boolean }> => {
    const allow = new Set(opts.connector?.secrets);
    const resolved = new Map<string, string>();
    let injected = false;
    const substitute = async (text: string): Promise<string> => {
      const refs = [...text.matchAll(SECRET_REF_RE)].map((m) => m[1]!);
      let out = text;
      for (const ref of refs) {
        if (!allow.has(ref)) {
          throw new Error(
            `secret "${ref}" is outside this connector's requires.secrets allowlist (issue #293)`,
          );
        }
        if (!resolved.has(ref)) {
          if (!opts.resolveSecret) throw new Error('no secret resolver is available for this run');
          const value = await opts.resolveSecret(ref);
          resolved.set(ref, value);
          resolvedSecretValues.add(value);
        }
        out = out.replaceAll(`{{secret:${ref}}}`, resolved.get(ref)!);
      }
      // Broker-injected connection values (issue #304): the placeholder
      // names what the credential carries (`access_token` / `api_key`);
      // an unknown name — or no broker credential at all — is a handler
      // bug surfaced as an error, never an empty substitution.
      for (const m of out.matchAll(CONNECTION_REF_RE)) {
        const name = m[1]!;
        const value = connectionValues[name];
        if (value === undefined) {
          throw new Error(
            Object.keys(connectionValues).length === 0
              ? 'this connection carries no broker credential — attach one with sync.configure_credential (issue #304)'
              : `connection credential has no "${name}" value (carries: ${Object.keys(connectionValues).join(', ')})`,
          );
        }
        injected = true;
        resolvedSecretValues.add(value);
        out = out.replaceAll(`{{connection:${name}}}`, value);
      }
      return out;
    };
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec.headers ?? {})) headers[k] = await substitute(v);
    return {
      spec: {
        url: await substitute(spec.url),
        ...(spec.method ? { method: spec.method } : {}),
        ...(spec.headers ? { headers } : {}),
        ...(spec.body !== undefined ? { body: await substitute(spec.body) } : {}),
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
      entry.startsWith('*.')
        ? url.hostname.endsWith(entry.slice(1)) && url.hostname.length > entry.length - 1
        : url.hostname === entry,
    );
  const isLoopback = (url: URL): boolean =>
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  const assertInjectable = (rawUrl: string): void => {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' && !isLoopback(url)) {
      throw new Error(`injected fetch refuses non-https destination ${url.hostname} (issue #304)`);
    }
    if (!hostAllowed(url)) {
      throw new Error(
        `host "${url.hostname}" is outside this connection's allowed_hosts — the credential is pinned to ${(opts.connectionAuth?.allowedHosts ?? []).join(', ')} (issue #304)`,
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
        reject(new Error('aborted'));
      };
      const cleanup = (): void => {
        clearTimeout(t);
        dispatchCtx.abortSignal.removeEventListener('abort', onAbort);
      };
      dispatchCtx.abortSignal.addEventListener('abort', onAbort, { once: true });
    });

  interface FetchWireResult {
    status: number;
    headers: Record<string, string>;
    text: string;
  }

  // One HTTP round trip. Injected requests never auto-follow redirects — a
  // cross-host Location would carry the Authorization header somewhere the
  // pin never approved; the handler sees the 3xx and follows deliberately.
  const fetchOnce = async (spec: FetchSpecWire, injected: boolean): Promise<FetchWireResult> => {
    const response = await fetch(spec.url, {
      method: spec.method ?? 'GET',
      ...(spec.headers ? { headers: spec.headers } : {}),
      ...(spec.body !== undefined ? { body: spec.body } : {}),
      ...(injected ? { redirect: 'manual' as const } : {}),
      signal: dispatchCtx.abortSignal,
    });
    const text = (await response.text()).slice(0, 2 * 1024 * 1024);
    return {
      status: response.status,
      headers: {
        'content-type': response.headers.get('content-type') ?? '',
        ...(response.headers.get('retry-after')
          ? { 'retry-after': response.headers.get('retry-after')! }
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
  const executeFetch = async (rawSpec: FetchSpecWire): Promise<FetchWireResult> => {
    let { spec, injected } = await substituteSecrets(rawSpec, opts.connectionAuth?.values ?? {});
    if (!injected) return fetchOnce(spec, false);
    assertInjectable(spec.url);
    const auth = opts.connectionAuth!;
    const gated = (s: FetchSpecWire): Promise<FetchWireResult> =>
      auth.limit ? auth.limit(() => fetchOnce(s, true)) : fetchOnce(s, true);
    const retryDelays = opts.fetchRetryDelaysMs ?? [1000, 4000];
    let transientRetries = 0;
    let refreshed = false;
    for (;;) {
      const result = await gated(spec);
      if (result.status === 429 || result.status >= 500) {
        if (transientRetries >= retryDelays.length) return result;
        const planned = retryDelays[transientRetries]!;
        const retryAfterMs = Number(result.headers['retry-after']) * 1000;
        await abortableDelay(
          Math.min(Number.isFinite(retryAfterMs) ? Math.max(retryAfterMs, planned) : planned, 30_000),
        );
        transientRetries += 1;
        continue;
      }
      if (result.status === 401 && auth.refresh && !refreshed) {
        refreshed = true;
        // A refusal here means the broker already flipped needs-auth — the
        // thrown message is what the run records.
        const values = await auth.refresh();
        ({ spec } = await substituteSecrets(rawSpec, values));
        continue;
      }
      if (result.status === 401) {
        await auth
          .onAuthDead?.('external service rejected the credential (401)')
          .catch(() => undefined);
        return result;
      }
      if (result.status === 403 && /insufficient.{0,4}(scope|permission)|invalid_scope/i.test(result.text)) {
        await auth
          .onAuthDead?.(
            'permission withdrawn upstream (403 insufficient scope) — reconnect with the scopes this connector needs',
          )
          .catch(() => undefined);
        return result;
      }
      return result;
    }
  };

  const emit = opts.onRunEvent ?? noopRunEventSink;
  const audit: AuditState = {
    store: opts.runsStore,
    runId: opts.runId,
    automationId: opts.automationId,
    ordinal: 0,
    nextBatchId: 1,
    emit,
  };

  // Each fire is its own execution conversation (fresh id, tagged with the
  // automation ref), so independent runs aren't piled into one perpetual
  // thread. The `<appId>/<id>` ref carries the app id in its first segment.
  const slash = audit.automationId.indexOf('/');
  const appId = slash > 0 ? audit.automationId.slice(0, slash) : undefined;
  const execConversationId = randomUUID();
  audit.store.createAutomationRun(execConversationId, audit.automationId, appId);
  const startedAt = Date.now();
  audit.store.insertTurn({
    turnId: audit.runId,
    conversationId: execConversationId,
    triggerKind: opts.triggerKind ?? 'scheduled',
    ...(opts.triggerOrigin ? { triggerOrigin: opts.triggerOrigin } : {}),
    ...(opts.parentRunId ? { parentTurnId: opts.parentRunId } : {}),
    startedAt,
  });
  // The trigger payload is the inbound `message_in` item (ordinal 0) — the
  // same shape a chat turn records (issue #190, criterion 4). Trace items
  // (tool/agent) then start at ordinal 1.
  if (opts.input !== undefined) {
    audit.store.insertMessageIn({
      turnId: audit.runId,
      role: 'user',
      text: truncateForAudit(opts.input) ?? '',
      startedAt,
    });
    audit.ordinal = 1;
  }
  // `run.start` opens the live stream; a viewer that joins later replays it
  // from the ledger instead. Guarded — a wedged sink must not fail the run.
  try {
    emit({ type: 'run.start', runId: audit.runId });
  } catch {
    /* swallow */
  }

  const worker = new Worker(WORKER_FILE, {
    workerData: {
      handlerFile: opts.handlerFile,
      args: { automation: { id: opts.automationId } },
      input: opts.input,
    },
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
  });

  let timeoutHandle: NodeJS.Timeout | undefined;
  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      abortController.abort('timeout');
      // eslint-disable-next-line unicorn/require-post-message-target-origin -- grandfathered pre-existing suppression (#247)
      worker.postMessage({ type: 'abort', reason: 'timeout' });
      setTimeout(() => {
        worker.terminate().catch(() => {});
      }, 2000);
    }, timeoutMs);
  }

  const send = (msg: unknown): void => {
    // eslint-disable-next-line unicorn/require-post-message-target-origin -- grandfathered pre-existing suppression (#247)
    worker.postMessage(msg);
  };

  return await new Promise<HandlerOutcome>((resolve) => {
    const state: PendingState = { resolve, resolved: false };

    const finish = (outcome: HandlerOutcome): void => {
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
          outcome.output = JSON.parse(scrub(JSON.stringify(outcome.output))) as unknown;
        }
        if (outcome.value !== undefined) {
          outcome.value = JSON.parse(scrub(JSON.stringify(outcome.value))) as unknown;
        }
        outcome.logs = outcome.logs.map((l) => ({ ...l, msg: scrub(l.msg) }));
        for (const entry of persistedEntries) entry.msg = scrub(entry.msg);
      }
      audit.store.finishTurn({
        turnId: audit.runId,
        endedAt: Date.now(),
        ok: outcome.ok,
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.summary ? { summary: outcome.summary } : {}),
        ...(outcome.output !== undefined
          ? { outputJson: truncateForAudit(outcome.output) ?? '' }
          : {}),
      });
      try {
        emit({
          type: 'run.end',
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
      if (persistedEntries.length > 0) void appendLogs(opts.automationDir, persistedEntries);
      // eslint-disable-next-line promise/no-multiple-resolved -- grandfathered pre-existing suppression (#247)
      resolve(outcome);
    };

    worker.on('message', (msg: WorkerToParentMessage) => {
      if (msg.type === 'tool-batch') {
        toolBatches++;
        // Requires-as-allowlist (issue #290): a connector's disallowed call
        // errors WITHOUT reaching the dispatcher — allowed calls in the same
        // batch still run, so one stray call degrades, never widens.
        if (opts.connector) {
          const allow = new Set(opts.connector.tools);
          const blocked = msg.calls.filter((c) => !allow.has(c.name));
          if (blocked.length > 0) {
            const allowed = msg.calls.filter((c) => allow.has(c.name));
            void (
              allowed.length > 0
                ? dispatchToolBatch({
                    audit,
                    toolDispatcher: opts.toolDispatcher,
                    dispatchCtx,
                    calls: allowed,
                  })
                : Promise.resolve([] as Awaited<ReturnType<typeof dispatchToolBatch>>)
            )
              .then((allowedResults) => {
                let i = 0;
                const results = msg.calls.map((c) =>
                  allow.has(c.name)
                    ? allowedResults[i++]
                    : {
                        ok: false,
                        error: `tool "${c.name}" is outside this connector's requires.tools allowlist (issue #290)`,
                      },
                );
                send({ type: 'tool-reply', id: msg.id, results });
              })
              .catch((err: unknown) => {
                const errorMsg = err instanceof Error ? err.message : String(err);
                send({
                  type: 'tool-reply',
                  id: msg.id,
                  results: msg.calls.map(() => ({ ok: false, error: errorMsg })),
                });
              });
            return;
          }
        }
        void dispatchToolBatch({
          audit,
          toolDispatcher: opts.toolDispatcher,
          dispatchCtx,
          calls: msg.calls,
        })
          .then((results) => {
            send({ type: 'tool-reply', id: msg.id, results });
          })
          .catch((err: unknown) => {
            const errorMsg = err instanceof Error ? err.message : String(err);
            send({
              type: 'tool-reply',
              id: msg.id,
              results: msg.calls.map(() => ({ ok: false, error: errorMsg })),
            });
          });
        return;
      }
      if (msg.type === 'agent') {
        // Connectors are deterministic code — no LLM turn ever runs inside
        // a sync loop (issue #290: agents write code, not data).
        if (opts.connector) {
          send({
            type: 'agent-reply',
            id: msg.id,
            ok: false,
            error:
              'ctx.agent is forbidden in connector handlers — connectors are deterministic published code; repair happens at authoring time (issue #290)',
          });
          return;
        }
        agentCalls++;
        void handleAgentMessage(
          audit,
          dispatchCtx,
          opts.agentDispatcher,
          msg.prompt,
          msg.json,
          msg.content,
          opts.vault,
        ).then((reply) => {
          send({ type: 'agent-reply', id: msg.id, ...reply });
        });
        return;
      }
      if (msg.type === 'fetch') {
        // Transport-level secret injection (issue #293): connector-only —
        // the recorded spec keeps its placeholders; substitution happens
        // here, past the worker boundary, and the response rides back to
        // the handler without ever being journaled.
        if (!opts.connector) {
          send({
            type: 'fetch-reply',
            id: msg.id,
            ok: false,
            error: 'ctx.fetch is connector-only (issue #293) — declare manifest.connector',
          });
          return;
        }
        logs.push({ level: 'info', msg: `fetch ${msg.spec.method ?? 'GET'} ${msg.spec.url}` });
        void executeFetch(msg.spec)
          .then((result) => {
            send({ type: 'fetch-reply', id: msg.id, ok: true, result });
          })
          .catch((err: unknown) => {
            send({
              type: 'fetch-reply',
              id: msg.id,
              ok: false,
              error: scrub(err instanceof Error ? err.message : String(err)),
            });
          });
        return;
      }
      if (msg.type === 'state') {
        send({
          type: 'state-reply',
          id: msg.id,
          ...handleStateMessage(audit, msg.method, msg.key, msg.value),
        });
        return;
      }
      if (msg.type === 'runs') {
        send({
          type: 'runs-reply',
          id: msg.id,
          ...handleRunsMessage(audit, msg.method, msg.filter),
        });
        return;
      }
      if (msg.type === 'vault') {
        void handleVaultMessage(audit, opts.vault, msg.op, msg.payload).then((reply) => {
          send({ type: 'vault-reply', id: msg.id, ...reply });
        });
        return;
      }
      if (msg.type === 'log') {
        logs.push({ level: msg.level, msg: msg.msg });
        persistedEntries.push({
          ts: Date.now(),
          level: msg.level,
          msg: msg.msg,
          source: 'action',
          handler: handlerName,
        });
        return;
      }
      if (msg.type === 'result') {
        const envelope = msg.ok
          ? extractReturnEnvelope(msg.value)
          : ({ value: msg.value } satisfies HandlerReturnEnvelope);
        let outcomeError = msg.error;
        let outcomeOk = msg.ok;
        if (msg.ok && opts.outputSchema && envelope.output !== undefined) {
          const schemaErr = validateOutputAgainstSchema(opts.outputSchema, envelope.output);
          if (schemaErr) {
            outcomeOk = false;
            outcomeError = `outputSchema validation failed: ${schemaErr}`;
          }
        }
        if (!outcomeOk && outcomeError) {
          persistedEntries.push({
            ts: Date.now(),
            level: 'error',
            msg: `automation handler failed: ${outcomeError}`,
            source: 'action',
            handler: handlerName,
          });
        }
        finish({
          ok: outcomeOk,
          value: envelope.value,
          ...(envelope.summary !== undefined ? { summary: envelope.summary } : {}),
          ...(envelope.output !== undefined ? { output: envelope.output } : {}),
          ...(outcomeError !== undefined ? { error: outcomeError } : {}),
          logs,
          toolBatches,
          agentCalls,
        });
      }
    });

    worker.on('error', (err) => {
      persistedEntries.push({
        ts: Date.now(),
        level: 'error',
        msg: `worker error: ${err.message}`,
        source: 'action',
        handler: handlerName,
      });
      finish({ ok: false, error: err.message, logs, toolBatches, agentCalls });
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        persistedEntries.push({
          ts: Date.now(),
          level: 'error',
          msg: `worker exited with code ${code}`,
          source: 'action',
          handler: handlerName,
        });
        finish({
          ok: false,
          error: `worker exited with code ${code}`,
          logs,
          toolBatches,
          agentCalls,
        });
      }
    });
  });
}
