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

export interface AgentCall {
  readonly prompt: string;
  readonly json?: unknown;
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

type WorkerToParentMessage =
  | { type: 'tool-batch'; id: number; calls: ToolCallWire[] }
  | { type: 'agent'; id: number; prompt: string; json?: unknown }
  | { type: 'state'; id: number; method: 'get' | 'set' | 'delete'; key: string; value?: unknown }
  | {
      type: 'runs';
      id: number;
      method: 'last' | 'list';
      filter: { automationId?: string; status?: 'ok' | 'error'; since?: number; limit?: number };
    }
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
      // eslint-disable-next-line unicorn/require-post-message-target-origin
      worker.postMessage({ type: 'abort', reason: 'timeout' });
      setTimeout(() => {
        worker.terminate().catch(() => {});
      }, 2000);
    }, timeoutMs);
  }

  const send = (msg: unknown): void => {
    // eslint-disable-next-line unicorn/require-post-message-target-origin
    worker.postMessage(msg);
  };

  return await new Promise<HandlerOutcome>((resolve) => {
    const state: PendingState = { resolve, resolved: false };

    const finish = (outcome: HandlerOutcome): void => {
      if (state.resolved) return;
      state.resolved = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
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
      // eslint-disable-next-line promise/no-multiple-resolved
      resolve(outcome);
    };

    worker.on('message', (msg: WorkerToParentMessage) => {
      if (msg.type === 'tool-batch') {
        toolBatches++;
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
        agentCalls++;
        void handleAgentMessage(
          audit,
          dispatchCtx,
          opts.agentDispatcher,
          msg.prompt,
          msg.json,
        ).then((reply) => {
          send({ type: 'agent-reply', id: msg.id, ...reply });
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
