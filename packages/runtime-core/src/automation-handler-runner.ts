/**
 * Parent-side orchestrator for automation handlers.
 *
 * Counterpart to `handler-runner.ts` (queries / actions). Differences:
 *
 *   1. Worker entry is `worker/automation-runner.js`, exposing
 *      `ctx.tool` / `ctx.agent` / `ctx.state` / `ctx.runs` / `ctx.invoke`
 *      instead of `ctx.fetch`.
 *   2. The parent supplies `toolDispatcher`, `agentDispatcher`, and
 *      (issue #80) an optional `invokeDispatcher`. The runtime-core
 *      layer doesn't know how to load + execute a sibling automation
 *      by name — that's host-specific.
 *   3. Tool calls arrive in batches; each call becomes one `run_nodes`
 *      audit row. There is no runtime retry — a failed `ctx.tool`
 *      rejects the handler Promise (see `automation-handler-ctx.ts`).
 *   4. (Issue #80) Every ctx surface call lands in the per-app
 *      `automations.sqlite`. `ctx.state` / `ctx.runs` read+write the
 *      same file. Retention runs at end-of-run per
 *      `manifest.history.keep`.
 */

import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { AppRef } from './types.js';
import { appendLogs, type LogEntry } from './log-store.js';
import { trackChanges } from './change-tracker.js';
import type { AutomationRunsStore } from './automation-runs-store.js';
import type { AutomationHistoryConfig, AutomationOutputSchema } from './automation-manifest.js';
import { validateOutputAgainstSchema } from './automation-manifest-output.js';
import type { AutomationTriggerKind } from './automation-runs-schema.js';
import {
  applyRetention,
  extractReturnEnvelope,
  recordAgentNode,
  truncateForAudit,
  type HandlerReturnEnvelope,
} from './automation-handler-audit.js';
import {
  dispatchToolBatch,
  handleInvokeMessage,
  handleRunsMessage,
  handleStateMessage,
  nextOrdinal,
  type AuditState,
  type ToolCallWire,
} from './automation-handler-ctx.js';

function resolveWorkerFile(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const jsPath = path.join(here, 'worker', 'automation-runner.js');
  if (existsSync(jsPath)) return jsPath;
  // Running tests via tsx from src/ where .js isn't emitted — fall back to
  // the .ts source. tsx propagates its loader to spawned Workers via
  // NODE_OPTIONS, so this works under `tsx --test`.
  return path.join(here, 'worker', 'automation-runner.ts');
}

const WORKER_FILE = resolveWorkerFile();

export interface AutomationToolCall {
  readonly name: string;
  readonly args: unknown;
}

export interface AutomationToolResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type AutomationToolDispatcher = (
  calls: readonly AutomationToolCall[],
  ctx: AutomationDispatchContext,
) => Promise<AutomationToolResult[]>;

export interface AutomationAgentCall {
  readonly prompt: string;
  readonly json?: unknown;
}

export type AutomationAgentDispatcher = (
  call: AutomationAgentCall,
  ctx: AutomationDispatchContext,
) => Promise<unknown>;

/**
 * Result of an `invokeDispatcher` call. `output` is the child handler's
 * return value (surfaced to `ctx.invoke`'s caller); `childRunId` links
 * the parent's `invoke` audit node to the child run for the DAG view.
 */
export interface AutomationInvokeResult {
  output: unknown;
  childRunId?: string;
}

export type AutomationInvokeDispatcher = (
  name: string,
  args: { input?: unknown; parentRunId: string },
  ctx: AutomationDispatchContext,
) => Promise<AutomationInvokeResult>;

export interface AutomationDispatchContext {
  readonly runId: string;
  readonly appId: string;
  readonly automationName: string;
  readonly abortSignal: AbortSignal;
}

export interface RunAutomationHandlerOptions {
  app: AppRef;
  handlerFile: string;
  automationName: string;
  runId: string;
  toolDispatcher: AutomationToolDispatcher;
  agentDispatcher: AutomationAgentDispatcher;
  invokeDispatcher?: AutomationInvokeDispatcher;
  /** Per-app `automations.sqlite` store for audit + ctx.state + ctx.runs. */
  runsStore: AutomationRunsStore;
  triggerKind?: AutomationTriggerKind;
  input?: unknown;
  parentRunId?: string;
  outputSchema?: AutomationOutputSchema;
  history?: AutomationHistoryConfig;
  onWrite?: (tables: string[]) => void;
  timeoutMs?: number;
}

export interface AutomationHandlerOutcome {
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
  resolve: (outcome: AutomationHandlerOutcome) => void;
  resolved: boolean;
}

type WorkerToParentMessage =
  | { type: 'db'; id: number; method: string; payload: Record<string, unknown> }
  | { type: 'tool-batch'; id: number; calls: ToolCallWire[] }
  | { type: 'agent'; id: number; prompt: string; json?: unknown }
  | { type: 'state'; id: number; method: 'get' | 'set' | 'delete'; key: string; value?: unknown }
  | {
      type: 'runs';
      id: number;
      method: 'last' | 'list';
      filter: { name?: string; status?: 'ok' | 'error'; since?: number; limit?: number };
    }
  | { type: 'invoke'; id: number; name: string; input?: unknown }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; msg: string }
  | { type: 'result'; ok: boolean; value?: unknown; error?: string };

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

interface DbPayload {
  sql?: string;
  params?: unknown[];
  begin?: boolean;
  commit?: boolean;
  rollback?: boolean;
}

function handleDb(
  db: DatabaseSync,
  method: string,
  payload: DbPayload,
): { ok: boolean; result?: unknown; error?: string } {
  try {
    const sql = String(payload.sql ?? '');
    const params = (payload.params ?? []) as SQLInputValue[];
    switch (method) {
      case 'exec':
        db.exec(sql);
        return { ok: true };
      case 'prepare-run': {
        const r = db.prepare(sql).run(...params);
        return { ok: true, result: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } };
      }
      case 'prepare-get':
        return { ok: true, result: db.prepare(sql).get(...params) };
      case 'prepare-all':
        return { ok: true, result: db.prepare(sql).all(...params) };
      case 'transaction-run':
        if (payload.begin) db.exec('BEGIN');
        else if (payload.commit) db.exec('COMMIT');
        else if (payload.rollback) db.exec('ROLLBACK');
        return { ok: true };
      default:
        return { ok: false, error: `unknown db method: ${method}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runAutomationHandler(
  opts: RunAutomationHandlerOptions,
): Promise<AutomationHandlerOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dbFile = path.join(opts.app.dir, 'data.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  const tracker = opts.onWrite ? trackChanges(db) : undefined;

  const logs: AutomationHandlerOutcome['logs'] = [];
  const persistedEntries: LogEntry[] = [];
  const handlerName = path.basename(opts.handlerFile).replace(/\.js$/, '');

  const abortController = new AbortController();
  const dispatchCtx: AutomationDispatchContext = {
    runId: opts.runId,
    appId: opts.app.id,
    automationName: opts.automationName,
    abortSignal: abortController.signal,
  };

  let toolBatches = 0;
  let agentCalls = 0;

  const audit: AuditState = {
    store: opts.runsStore,
    runId: opts.runId,
    automationName: opts.automationName,
    ordinal: 0,
    nextBatchId: 1,
  };

  audit.store.insertRun({
    runId: audit.runId,
    automationName: audit.automationName,
    triggerKind: opts.triggerKind ?? 'scheduled',
    ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
    ...(opts.input !== undefined ? { inputJson: truncateForAudit(opts.input) ?? '' } : {}),
    startedAt: Date.now(),
  });

  const worker = new Worker(WORKER_FILE, {
    workerData: {
      handlerFile: opts.handlerFile,
      args: { app: { id: opts.app.id, dir: opts.app.dir } },
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

  return await new Promise<AutomationHandlerOutcome>((resolve) => {
    const state: PendingState = { resolve, resolved: false };

    const finish = (outcome: AutomationHandlerOutcome): void => {
      if (state.resolved) return;
      state.resolved = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (tracker && opts.onWrite && outcome.ok) {
        try {
          const tables = tracker.extract();
          if (tables.length > 0) opts.onWrite(tables);
        } catch {
          /* never let tracking change the handler outcome */
        }
      } else {
        tracker?.close();
      }
      try {
        db.close();
      } catch {
        /* ignore */
      }
      audit.store.finishRun({
        runId: audit.runId,
        endedAt: Date.now(),
        ok: outcome.ok,
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.summary ? { summary: outcome.summary } : {}),
        ...(outcome.output !== undefined
          ? { outputJson: truncateForAudit(outcome.output) ?? '' }
          : {}),
      });
      applyRetention(audit.store, audit.automationName, opts.history);
      abortController.abort();
      worker.removeAllListeners();
      worker.terminate().catch(() => {});
      if (persistedEntries.length > 0) void appendLogs(opts.app.dir, persistedEntries);
      // eslint-disable-next-line promise/no-multiple-resolved
      resolve(outcome);
    };

    worker.on('message', (msg: WorkerToParentMessage) => {
      if (msg.type === 'db') {
        const reply = handleDb(db, msg.method, msg.payload);
        send({ type: 'db-reply', id: msg.id, ...reply });
        return;
      }
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
        const ordinal = nextOrdinal(audit);
        const started = Date.now();
        void opts
          .agentDispatcher({ prompt: msg.prompt, json: msg.json }, dispatchCtx)
          .then((result) => {
            recordAgentNode({
              store: audit.store,
              runId: audit.runId,
              ordinal,
              prompt: msg.prompt,
              ok: true,
              result,
              started,
              ended: Date.now(),
            });
            send({ type: 'agent-reply', id: msg.id, ok: true, result });
          })
          .catch((err: unknown) => {
            const errorMsg = err instanceof Error ? err.message : String(err);
            recordAgentNode({
              store: audit.store,
              runId: audit.runId,
              ordinal,
              prompt: msg.prompt,
              ok: false,
              error: errorMsg,
              started,
              ended: Date.now(),
            });
            send({ type: 'agent-reply', id: msg.id, ok: false, error: errorMsg });
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
      if (msg.type === 'invoke') {
        void handleInvokeMessage(
          audit,
          dispatchCtx,
          opts.invokeDispatcher,
          msg.name,
          msg.input,
        ).then((reply) => {
          send({ type: 'invoke-reply', id: msg.id, ...reply });
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
