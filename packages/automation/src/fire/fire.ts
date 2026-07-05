/**
 * Automation fire spine — the per-fire orchestration, owned here in
 * app-engine (issue #147, Concern 2).
 *
 * Resolving an automation, opening its run ledger, running the generated
 * `handler.js`, and cascading `onFailure` only ever touch app-engine
 * primitives (`parseRef`, `AgentRunsStore`,
 * `runHandler`). That spine used to live in
 * `agent-runtime/run-automation.ts`; the only thing it genuinely
 * needed from agent-runtime was the live `ctx.tool` / `ctx.agent` dispatch
 * surface (the mock-LLM server + CLI spawn). So the spine moves down and the
 * dispatch surface is injected via `openDispatch` — the same dependency
 * inversion the `Host` / `ConversationRunner` seams already use.
 *
 * agent-runtime's `runAutomation` is now a thin wrapper that builds the
 * `openDispatch` closure (capturing the runner kind + CLI spawn) and calls
 * `runFire`. A second host (e.g. openclaw) can inject its own
 * dispatch surface instead of reimplementing the spine.
 */

import { randomUUID } from 'node:crypto';
import {
  ConversationStore,
  makeTranscriptsDbProvider,
  type AnalyticsStore,
  type AutomationTriggerKind,
  type AutomationTriggerOrigin,
  type RunStreamEvent,
  type VaultBridge,
} from '@centraid/app-engine';
import { parseRef } from '../manifest/ref.js';
import { handlerPath, readAppOwned } from '../scaffold/app.js';
import { runHandler } from '../handler/runner.js';
import type { AgentDispatcher, HandlerOutcome, ToolDispatcher } from '../handler/runner.js';

/**
 * The live dispatch surface a fire runs against. Provided by the host
 * (agent-runtime stands up a mock-LLM server + CLI spawn). `close()` tears
 * down whatever the host allocated and is always called once, even on throw.
 */
export interface DispatchSurface {
  toolDispatcher: ToolDispatcher;
  agentDispatcher: AgentDispatcher;
  close(): Promise<void>;
}

/** Args app-engine hands the host when it needs a dispatch surface for a fire. */
export interface OpenDispatchArgs {
  /** The automation app directory — the host's CLI cwd. */
  workdir: string;
  /** `<appId>/<automationId>` handle being fired. */
  automationRef: string;
  runId: string;
  /** Manifest `requires.tools` allowlist to scope the host's tool surface. */
  toolsAllow: readonly string[];
  /**
   * Manifest `requires.model` — the capability tier `ctx.agent` should route
   * to (issue #166). The host's `agentDispatcher` picks the matching provider
   * tier; undefined means "the host's default automation model".
   */
  model?: string;
  onLog: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/** The injected seam: open a live dispatch surface for one fire. */
export type OpenDispatch = (args: OpenDispatchArgs) => Promise<DispatchSurface>;

export interface RunFireOptions {
  /** `<appId>/<automationId>` handle of the automation to fire. */
  automationRef: string;
  /**
   * Caller-supplied run id. Lets the caller open the run viewer before the
   * fire completes. Defaults to `<ref>:<ts>:<uuid8>`.
   */
  runId?: string;
  /**
   * Directory holding the per-app *state* folders (logs, settings.json).
   * Survives version swaps (it is never inside a git worktree). Per-vault
   * since #280.
   */
  appsDir: string;
  /**
   * The vault's `transcripts.db` file — the run ledger every fire writes
   * (issue #280: one per-vault ledger; the per-app `runtime.sqlite` is gone).
   */
  transcriptsDbFile: string;
  /**
   * Directory holding the per-app *code* folders — automation manifests +
   * handlers resolve from `<codeAppsDir>/<appId>/automations/<id>/` (issue
   * #137: the gateway's git-store materialized `main`). Defaults to `appsDir`
   * when omitted, for the legacy/flat layout where code and data share a tree.
   */
  codeAppsDir?: string;
  /**
   * Central analytics store. When set, the per-app run ledger write-throughs
   * each finished run's summary to it (issue #98).
   */
  analytics?: AnalyticsStore;
  /**
   * Host-injected `ctx.vault` executor factory, keyed by the automation's
   * app id: each fire gets a bridge bound to *that* app's enrolled
   * `agent.agent` credential (duaility §12), so a cross-app `onFailure`
   * cascade acts as its own agent, never the parent's. The package stays
   * vault-free — the gateway builds this off its vault plane. Absent (or
   * returning undefined) → `ctx.vault` fails closed with `VAULT_UNAVAILABLE`.
   */
  vaultFor?: (appId: string) => VaultBridge | undefined;
  /** Hard timeout. Defaults to the handler runner's default. */
  timeoutMs?: number;
  /** Optional logger. */
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /**
   * Live run-stream sink (issue #158) for THIS fire's run. Not propagated
   * into `onFailure` cascades — those are separate runs with their own ids
   * and ledgers, so streaming them onto this run's channel would mislabel
   * their events. A late viewer can open the child run by its own id.
   */
  onRunEvent?: (ev: RunStreamEvent) => void;
  /**
   * Trigger that caused this fire. Defaults to `'scheduled'`. The onFailure
   * dispatch loop uses `'on_failure'`.
   */
  triggerKind?: AutomationTriggerKind;
  /**
   * Source that fired this run (`cron` / `webhook` / `manual`). Defaults to
   * `'cron'` — the scheduler is the usual local caller.
   */
  triggerOrigin?: AutomationTriggerOrigin;
  /** Optional input payload (e.g. for on_failure dispatch). */
  input?: unknown;
  /** Optional parent run id for the onFailure sub-run DAG link. */
  parentRunId?: string;
  /**
   * Recursion guard for `onFailure` cascades. Defaults to 0 — the runtime
   * refuses to push the chain past depth 3.
   */
  failureDepth?: number;
}

export interface RunRecord {
  /** `<appId>/<automationId>` handle of the fired automation. */
  automationRef: string;
  automationName: string;
  runId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  ok: boolean;
  error?: string;
  toolBatches: number;
  agentCalls: number;
}

/**
 * Single automation fire. Resolves the automation, opens its ledger, runs the
 * handler against the host-supplied dispatch surface, cascades `onFailure`,
 * and returns the run record + handler outcome. A missing automation app
 * throws; a handler failure surfaces in `outcome.ok === false`.
 */
export async function runFire(
  opts: RunFireOptions,
  deps: { openDispatch: OpenDispatch },
): Promise<{ outcome: HandlerOutcome; record: RunRecord }> {
  const onLog = opts.onLog ?? (() => undefined);

  // Code (manifest + handler) resolves from `codeAppsDir`; data
  // (runtime.sqlite) from `appsDir`. They diverge under the git-store backend
  // (issue #137) and coincide in the flat/legacy layout.
  const codeAppsDir = opts.codeAppsDir ?? opts.appsDir;

  const parsed = parseRef(opts.automationRef);
  if (!parsed) {
    throw new Error(`automation "${opts.automationRef}": not a valid <appId>/<id> handle`);
  }
  const row = await readAppOwned(codeAppsDir, parsed.appId, parsed.automationId);
  if (!row) {
    throw new Error(`automation ${opts.automationRef}: not found under ${codeAppsDir}`);
  }

  // The automation's run ledger is its vault's `transcripts.db` (#280);
  // `finishRun` write-throughs a summary to `analytics` (same file).
  const runsStore = new ConversationStore(
    makeTranscriptsDbProvider(opts.transcriptsDbFile),
    opts.analytics,
  );
  const runId = opts.runId ?? `${opts.automationRef}:${Date.now()}:${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const failureDepth = opts.failureDepth ?? 0;
  const vaultBridge = opts.vaultFor?.(parsed.appId);

  const dispatch = await deps.openDispatch({
    workdir: row.dir,
    automationRef: opts.automationRef,
    runId,
    toolsAllow: row.manifest.requires.tools ?? [],
    ...(row.manifest.requires.model ? { model: row.manifest.requires.model } : {}),
    onLog,
  });

  let outcome: HandlerOutcome;
  try {
    outcome = await runHandler({
      automationId: opts.automationRef,
      automationDir: row.dir,
      handlerFile: handlerPath(row.dir),
      runId,
      toolDispatcher: dispatch.toolDispatcher,
      agentDispatcher: dispatch.agentDispatcher,
      runsStore,
      ...(vaultBridge ? { vault: vaultBridge } : {}),
      ...(opts.onRunEvent ? { onRunEvent: opts.onRunEvent } : {}),
      triggerKind: opts.triggerKind ?? 'scheduled',
      triggerOrigin: opts.triggerOrigin ?? 'cron',
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
      ...(row.manifest.outputSchema ? { outputSchema: row.manifest.outputSchema } : {}),
      history: row.manifest.history,
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
  } finally {
    await dispatch.close().catch(() => undefined);
  }

  // onFailure cascade: when the handler fails and the manifest names a
  // follow-up automation, fire it with the failed run as input. The handle
  // resolves a bare id within the same app. Capped at depth 3.
  if (!outcome.ok && row.manifest.onFailure) {
    if (failureDepth >= 3) {
      onLog('warn', `onFailure cascade for ${row.name} aborted at depth ${failureDepth} (cap=3)`);
    } else {
      const failTarget = parseRef(row.manifest.onFailure, parsed.appId);
      const next = failTarget
        ? await readAppOwned(codeAppsDir, failTarget.appId, failTarget.automationId)
        : undefined;
      if (!next) {
        onLog('warn', `onFailure target "${row.manifest.onFailure}" not found for ${row.name}`);
      } else {
        try {
          await runFire(
            {
              automationRef: next.ref,
              appsDir: opts.appsDir,
              transcriptsDbFile: opts.transcriptsDbFile,
              ...(opts.codeAppsDir ? { codeAppsDir: opts.codeAppsDir } : {}),
              ...(opts.analytics ? { analytics: opts.analytics } : {}),
              ...(opts.vaultFor ? { vaultFor: opts.vaultFor } : {}),
              ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
              onLog,
              triggerKind: 'on_failure',
              ...(opts.triggerOrigin ? { triggerOrigin: opts.triggerOrigin } : {}),
              input: { runId, automationName: row.name, error: outcome.error ?? 'unknown error' },
              parentRunId: runId,
              failureDepth: failureDepth + 1,
            },
            deps,
          );
        } catch (err) {
          onLog(
            'error',
            `onFailure dispatch ${row.manifest.onFailure} threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  const endedAt = Date.now();
  const record: RunRecord = {
    automationRef: opts.automationRef,
    automationName: row.name,
    runId,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    ok: outcome.ok,
    ...(outcome.error ? { error: outcome.error } : {}),
    toolBatches: outcome.toolBatches,
    agentCalls: outcome.agentCalls,
  };
  return { outcome, record };
}
