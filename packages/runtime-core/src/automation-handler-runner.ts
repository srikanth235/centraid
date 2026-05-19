/**
 * Parent-side orchestrator for automation handlers.
 *
 * Counterpart to `handler-runner.ts` (queries / actions). The differences
 * from the regular runner:
 *
 *   1. Different worker entry (`worker/automation-runner.js`) that
 *      exposes `ctx.tool` / `ctx.agent` instead of `ctx.fetch`.
 *   2. The parent must supply `toolDispatcher` and `agentDispatcher`
 *      injection points — the runtime-core layer doesn't know how to
 *      drive the host CLI / openclaw streamFn / etc. Those dispatchers
 *      are provided by:
 *
 *        - `@centraid/agent-runtime` for the local-side mock-LLM + CLI
 *          subprocess flow (`runAutomationLocal`)
 *        - `@centraid/openclaw-plugin` for the in-process StreamFn /
 *          `callGatewayTool` / `prepareSimpleCompletionModel` flow
 *
 *      Keeping the dispatchers *out* of runtime-core means runtime-core
 *      has no dependency on either openclaw or any specific LLM
 *      transport — the same worker plumbing serves both hosts.
 *
 *   3. Tool calls arrive *in batches* — each batch is one async-boundary's
 *      worth of `ctx.tool` calls. The dispatcher receives an array and
 *      returns an array of results in the same order. This is what
 *      enables one CLI-subprocess-per-batch on the local path.
 */

import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { AppRef } from './types.js';
import { appendLogs, type LogEntry } from './log-store.js';
import { trackChanges } from './change-tracker.js';

const WORKER_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'worker',
  'automation-runner.js',
);

export interface AutomationToolCall {
  /** Fully-qualified tool name as the handler passed it to `ctx.tool`. */
  readonly name: string;
  /** Arguments object passed to the tool. Opaque to runtime-core. */
  readonly args: unknown;
}

export interface AutomationToolResult {
  ok: boolean;
  result?: unknown;
  /** Plain-text error message — surfaced to the handler as a thrown Error. */
  error?: string;
}

/**
 * Host-supplied dispatcher for a batch of `ctx.tool` calls.
 *
 * Must resolve with `results.length === calls.length`, in the same
 * order. Throwing instead of returning is fatal to the run — surface
 * per-call failures via `{ok:false, error:...}` so the handler can
 * recover via try/catch if it wants.
 */
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
 * Per-run context handed to every dispatcher invocation. The host can
 * stash per-run state (mock-LLM port, dispatch id, openclaw `api`,
 * etc) on its own dispatcher closure — `runId` here is the
 * lower-bound stable identifier the runner generates for logging /
 * correlation.
 */
export interface AutomationDispatchContext {
  readonly runId: string;
  readonly appId: string;
  readonly automationName: string;
  readonly abortSignal: AbortSignal;
}

export interface RunAutomationHandlerOptions {
  app: AppRef;
  /** Absolute path to the `.js` action file. */
  handlerFile: string;
  /** Automation's name (manifest key) — used for log scoping and dispatcher context. */
  automationName: string;
  /** Stable id for this single fire. UUID or `<appId>:<name>:<ts>`. */
  runId: string;
  toolDispatcher: AutomationToolDispatcher;
  agentDispatcher: AutomationAgentDispatcher;
  /** Optional fire-and-forget write notification (mirrors handler-runner.ts). */
  onWrite?: (tables: string[]) => void;
  /** Hard timeout. Defaults to 5 minutes — the same as openclaw cron's default. */
  timeoutMs?: number;
}

export interface AutomationHandlerOutcome {
  ok: boolean;
  /** Optional summary string the handler may return for the run log. */
  value?: unknown;
  error?: string;
  logs: Array<{ level: 'info' | 'warn' | 'error'; msg: string }>;
  /** Number of batched tool dispatches the handler issued (telemetry). */
  toolBatches: number;
  /** Number of `ctx.agent` calls (telemetry). */
  agentCalls: number;
}

interface PendingState {
  resolve: (outcome: AutomationHandlerOutcome) => void;
  resolved: boolean;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function runAutomationHandler(
  opts: RunAutomationHandlerOptions,
): Promise<AutomationHandlerOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dbFile = path.join(opts.app.dir, 'data.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  // Automations write — track changes so subscribers (e.g. iframes
  // viewing the same app) refresh after a cron-driven write lands.
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

  const worker = new Worker(WORKER_FILE, {
    workerData: {
      handlerFile: opts.handlerFile,
      args: { app: { id: opts.app.id, dir: opts.app.dir } },
    },
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
  });

  const sendTimeoutAbort = (): void => {
    // eslint-disable-next-line unicorn/require-post-message-target-origin
    worker.postMessage({ type: 'abort', reason: 'timeout' });
  };

  let timeoutHandle: NodeJS.Timeout | undefined;
  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      abortController.abort('timeout');
      sendTimeoutAbort();
      // Hard kill if the worker doesn't honor the abort within a grace window.
      setTimeout(() => {
        worker.terminate().catch(() => {});
      }, 2000);
    }, timeoutMs);
  }

  const handleDb = (
    method: string,
    payload: {
      sql?: string;
      params?: unknown[];
      begin?: boolean;
      commit?: boolean;
      rollback?: boolean;
    },
  ): { ok: boolean; result?: unknown; error?: string } => {
    try {
      switch (method) {
        case 'exec':
          db.exec(String(payload.sql ?? ''));
          return { ok: true };
        case 'prepare-run': {
          const stmt = db.prepare(String(payload.sql ?? ''));
          const params = (payload.params ?? []) as SQLInputValue[];
          const r = stmt.run(...params);
          return { ok: true, result: { changes: r.changes, lastInsertRowid: r.lastInsertRowid } };
        }
        case 'prepare-get': {
          const stmt = db.prepare(String(payload.sql ?? ''));
          const params = (payload.params ?? []) as SQLInputValue[];
          return { ok: true, result: stmt.get(...params) };
        }
        case 'prepare-all': {
          const stmt = db.prepare(String(payload.sql ?? ''));
          const params = (payload.params ?? []) as SQLInputValue[];
          return { ok: true, result: stmt.all(...params) };
        }
        case 'transaction-run': {
          if (payload.begin) db.exec('BEGIN');
          else if (payload.commit) db.exec('COMMIT');
          else if (payload.rollback) db.exec('ROLLBACK');
          return { ok: true };
        }
        default:
          return { ok: false, error: `unknown db method: ${method}` };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  // The worker is in-process, no cross-origin concern — wrap the
  // postMessage calls so the lint suppressions live in one spot rather
  // than peppered across every reply site.
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
      abortController.abort();
      worker.removeAllListeners();
      worker.terminate().catch(() => {});
      if (persistedEntries.length > 0) {
        void appendLogs(opts.app.dir, persistedEntries);
      }
      // eslint-disable-next-line promise/no-multiple-resolved
      resolve(outcome);
    };

    worker.on(
      'message',
      (
        msg:
          | { type: 'db'; id: number; method: string; payload: Record<string, unknown> }
          | { type: 'tool-batch'; id: number; calls: AutomationToolCall[] }
          | { type: 'agent'; id: number; prompt: string; json?: unknown }
          | { type: 'log'; level: 'info' | 'warn' | 'error'; msg: string }
          | { type: 'result'; ok: boolean; value?: unknown; error?: string },
      ) => {
        if (msg.type === 'db') {
          const reply = handleDb(msg.method, msg.payload);
          send({ type: 'db-reply', id: msg.id, ...reply });
          return;
        }
        if (msg.type === 'tool-batch') {
          toolBatches++;
          void opts
            .toolDispatcher(msg.calls, dispatchCtx)
            .then((results) => {
              send({ type: 'tool-reply', id: msg.id, results });
            })
            .catch((err: unknown) => {
              const errorMsg = err instanceof Error ? err.message : String(err);
              // Dispatcher threw — surface per-call failures so the
              // handler's try/catch can react instead of dying silently.
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
          void opts
            .agentDispatcher({ prompt: msg.prompt, json: msg.json }, dispatchCtx)
            .then((result) => {
              send({ type: 'agent-reply', id: msg.id, ok: true, result });
            })
            .catch((err: unknown) => {
              send({
                type: 'agent-reply',
                id: msg.id,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
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
          if (!msg.ok && msg.error) {
            persistedEntries.push({
              ts: Date.now(),
              level: 'error',
              msg: `automation handler failed: ${msg.error}`,
              source: 'action',
              handler: handlerName,
            });
          }
          finish({
            ok: msg.ok,
            value: msg.value,
            error: msg.error,
            logs,
            toolBatches,
            agentCalls,
          });
        }
      },
    );

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
