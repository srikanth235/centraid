/**
 * Local-side automation fire (issue #98) — the agent-runtime wrapper over the
 * app-engine fire spine (issue #147, Concern 2).
 *
 * The per-fire orchestration (resolve the automation, open its ledger, run
 * `handler.js`, cascade `onFailure`) lives in app-engine's `runAutomationFire`
 * — it only touches app-engine primitives. The one thing it needs from
 * agent-runtime is the live `ctx.tool` / `ctx.agent` dispatch surface: an
 * ephemeral mock-LLM server plus a per-batch CLI subprocess spawn. This file
 * builds that surface (capturing the runner kind + spawn fn) and injects it as
 * `openDispatch`, leaving the spine — and the onFailure cascade — to app-engine.
 */

import { type AutomationTriggerKind, type AutomationTriggerOrigin } from '@centraid/app-engine';
import type { AnalyticsStore } from '@centraid/analytics';
import {
  runAutomationFire,
  type AutomationHandlerOutcome,
  type AutomationRunRecord,
  type OpenAutomationDispatch,
} from '@centraid/automation';
import {
  defaultSpawnCli,
  type LocalRunnerKind,
  type SpawnCli,
  type SpawnCliInput,
  type SpawnCliResult,
} from './run-automation-cli-spawn.js';
import { startLiveDispatch } from './run-automation-live-dispatch.js';

export {
  defaultSpawnCli,
  type LocalRunnerKind,
  type SpawnCli,
  type SpawnCliInput,
  type SpawnCliResult,
};
// The run record shape lives with the spine now; re-export so existing
// agent-runtime consumers keep importing it from here.
export type { AutomationRunRecord };

export interface RunAutomationLocalOptions {
  /** `<appId>/<automationId>` handle of the automation to fire. */
  automationRef: string;
  /**
   * Caller-supplied run id. Lets the caller open the run viewer before the
   * fire completes. Defaults to `<ref>:<ts>:<uuid8>`.
   */
  runId?: string;
  /**
   * Directory holding the per-app *data* folders — each automation's run
   * ledger is `<appsDir>/<appId>/runtime.sqlite`. Survives version swaps.
   */
  appsDir: string;
  /**
   * Directory holding the per-app *code* folders — automation manifests +
   * handlers resolve from `<codeAppsDir>/<appId>/automations/<id>/` (issue
   * #137). Defaults to `appsDir` for the legacy/flat layout.
   */
  codeAppsDir?: string;
  /**
   * Central analytics store. When set, the per-app run ledger write-throughs
   * each finished run's summary to it (issue #98).
   */
  analytics?: AnalyticsStore;
  /** Which CLI to drive. Defaults to codex. */
  runner?: LocalRunnerKind;
  /** Hard timeout. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Override spawn for tests. */
  spawnCli?: SpawnCli;
  /** Optional logger. */
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
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

/**
 * Single automation fire. Returns the run record + the handler outcome. A
 * missing automation app throws; a handler failure surfaces in
 * `outcome.ok === false`.
 */
export async function runAutomationLocal(
  opts: RunAutomationLocalOptions,
): Promise<{ outcome: AutomationHandlerOutcome; record: AutomationRunRecord }> {
  const runner: LocalRunnerKind = opts.runner ?? 'codex';
  const spawnCli = opts.spawnCli ?? defaultSpawnCli;

  // The injected dispatch surface: a fresh mock-LLM server + CLI spawn per
  // fire. The runner kind + spawn fn are captured here, so onFailure cascades
  // (which app-engine drives by recursing with the same `openDispatch`) reuse
  // the same runner without re-threading config.
  const openDispatch: OpenAutomationDispatch = (args) =>
    startLiveDispatch({
      workdir: args.workdir,
      automationId: args.automationRef,
      runId: args.runId,
      runner,
      spawnCli,
      toolsAllow: args.toolsAllow,
      onLog: args.onLog,
    });

  return runAutomationFire(
    {
      automationRef: opts.automationRef,
      ...(opts.runId ? { runId: opts.runId } : {}),
      appsDir: opts.appsDir,
      ...(opts.codeAppsDir ? { codeAppsDir: opts.codeAppsDir } : {}),
      ...(opts.analytics ? { analytics: opts.analytics } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.onLog ? { onLog: opts.onLog } : {}),
      ...(opts.triggerKind ? { triggerKind: opts.triggerKind } : {}),
      ...(opts.triggerOrigin ? { triggerOrigin: opts.triggerOrigin } : {}),
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
      ...(opts.failureDepth !== undefined ? { failureDepth: opts.failureDepth } : {}),
    },
    { openDispatch },
  );
}
