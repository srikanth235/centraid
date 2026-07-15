/**
 * Local-side automation fire (issue #98) — `runAutomation`, the agent-runtime
 * wrapper over the fire spine (issue #147, Concern 2).
 *
 * The per-fire orchestration (resolve the automation, open its ledger, run
 * `handler.js`, cascade `onFailure`) lives in `@centraid/automation`'s `runFire`
 * — it only touches app-engine primitives. The one thing it needs from
 * agent-runtime is the live `ctx.tool` / `ctx.agent` dispatch surface: an
 * ephemeral mock-LLM server plus a per-fire host agent session (an in-process
 * Claude SDK turn, or a `codex exec` subprocess). This file
 * builds that surface (capturing the runner kind + spawn fn) and injects it as
 * `openDispatch`, leaving the spine — and the onFailure cascade — to app-engine.
 */

import {
  type AutomationTriggerKind,
  type AutomationTriggerOrigin,
  type RunStreamEvent,
  type VaultBridge,
} from '@centraid/app-engine';
import * as automation from '@centraid/automation';
import type { RunnerKind } from '../types.js';
import {
  defaultRunHostAgent,
  type RunHostAgent,
  type RunHostAgentInput,
  type RunHostAgentResult,
} from './run-automation-host-agent.js';
import { startLiveDispatch } from './run-automation-live-dispatch.js';

export { defaultRunHostAgent, type RunHostAgent, type RunHostAgentInput, type RunHostAgentResult };

export interface RunAutomationOptions {
  /** `<appId>/<automationId>` handle of the automation to fire. */
  automationRef: string;
  /**
   * Caller-supplied run id. Lets the caller open the run viewer before the
   * fire completes. Defaults to `<ref>:<ts>:<uuid8>`.
   */
  runId?: string;
  /**
   * Directory holding the per-app *state* folders (logs, settings.json),
   * inside the vault's workspace. Survives version swaps.
   */
  appsDir: string;
  /**
   * The vault's `journal.db` file — the run ledger every fire writes
   * (issue #280: one per-vault ledger; the per-app `runtime.sqlite` is gone).
   */
  journalDbFile: string;
  /**
   * Directory holding the per-app *code* folders — automation manifests +
   * handlers resolve from `<codeAppsDir>/<appId>/automations/<id>/` (issue
   * #137). Defaults to `appsDir` for the legacy/flat layout.
   */
  codeAppsDir?: string;
  /**
   * Host-injected `ctx.vault` executor factory keyed by app id (duaility
   * §12) — forwarded to the fire spine. Absent → `ctx.vault` fails closed.
   */
  vaultFor?: (appId: string) => VaultBridge | undefined;
  /** Which CLI to drive. Defaults to codex. */
  runner?: RunnerKind;
  /**
   * Fallback model id/alias for this fire's `ctx.agent` calls, applied only
   * when the automation's manifest doesn't set `requires.model` (that always
   * wins — see `runFire`'s `OpenDispatchArgs.model`). The caller resolves
   * this from prefs (`model.<runnerKind>.automations` → `model.<runnerKind>.default`)
   * before calling in; `undefined` here means "no prefs fallback either" —
   * the backend sends no `model` field and uses its own built-in default.
   */
  model?: string;
  /** Hard timeout. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Override spawn for tests. */
  runHostAgent?: RunHostAgent;
  /** Optional logger. */
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Live run-stream sink (issue #158); forwarded to the fire spine. */
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
  /**
   * Gateway broker seam (issue #304) — forwarded to the fire spine so a
   * connector's connection credential resolves and injects per fire.
   */
  resolveConnection?: automation.ResolveConnection;
}

/**
 * Single automation fire. Returns the run record + the handler outcome. A
 * missing automation app throws; a handler failure surfaces in
 * `outcome.ok === false`.
 */
export async function runAutomation(
  opts: RunAutomationOptions,
): Promise<{ outcome: automation.HandlerOutcome; record: automation.RunRecord }> {
  const runner: RunnerKind = opts.runner ?? 'codex';
  const runHostAgent = opts.runHostAgent ?? defaultRunHostAgent;

  // The injected dispatch surface: a fresh mock-LLM server + CLI spawn per
  // fire. The runner kind + spawn fn are captured here, so onFailure cascades
  // (which app-engine drives by recursing with the same `openDispatch`) reuse
  // the same runner without re-threading config.
  const openDispatch: automation.OpenDispatch = (args) =>
    startLiveDispatch({
      workdir: args.workdir,
      automationId: args.automationRef,
      runId: args.runId,
      runner,
      runHostAgent,
      toolsAllow: args.toolsAllow,
      // The manifest's `requires.model` (already folded into `args.model` by
      // `runFire`) always wins; `opts.model` is the caller's prefs-resolved
      // fallback for when the manifest doesn't specify one.
      ...((args.model ?? opts.model) ? { model: args.model ?? opts.model } : {}),
      onLog: args.onLog,
    });

  return automation.runFire(
    {
      automationRef: opts.automationRef,
      ...(opts.runId ? { runId: opts.runId } : {}),
      appsDir: opts.appsDir,
      journalDbFile: opts.journalDbFile,
      ...(opts.codeAppsDir ? { codeAppsDir: opts.codeAppsDir } : {}),
      ...(opts.vaultFor ? { vaultFor: opts.vaultFor } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.onLog ? { onLog: opts.onLog } : {}),
      ...(opts.onRunEvent ? { onRunEvent: opts.onRunEvent } : {}),
      ...(opts.triggerKind ? { triggerKind: opts.triggerKind } : {}),
      ...(opts.triggerOrigin ? { triggerOrigin: opts.triggerOrigin } : {}),
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
      ...(opts.failureDepth !== undefined ? { failureDepth: opts.failureDepth } : {}),
      ...(opts.resolveConnection ? { resolveConnection: opts.resolveConnection } : {}),
    },
    { openDispatch },
  );
}
