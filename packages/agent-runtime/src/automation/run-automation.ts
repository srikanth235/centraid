/**
 * Local-side automation fire (issue #98) — `runAutomation`, the agent-runtime
 * wrapper over the fire spine (issue #147, Concern 2).
 *
 * The per-fire orchestration (resolve the automation, open its ledger, run
 * `handler.js`, cascade `onFailure`) lives in `@centraid/automation`'s `runFire`
 * — it only touches app-engine primitives. The one thing it needs from
 * agent-runtime is the `ctx.agent` dispatch surface: a bounded model turn
 * against the user's real provider. This file builds that surface (capturing
 * the runner kind) and injects it as `openDispatch`, leaving the spine — and
 * the onFailure cascade — to app-engine.
 *
 * The captured kind is any registered `RunnerKind`: `startLiveDispatch` routes
 * `ctx.agent` through the `RunnerBackend` registry (issue #479). `'codex'`
 * remains the default only because a caller that names no runner gets the
 * historical one. Issue #484 removed the `ctx.tool` rail (and the eager
 * mock-LLM server it spawned per fire), so a fire whose handler never calls
 * `ctx.agent` starts zero child processes and zero HTTP servers.
 */

import { randomUUID } from 'node:crypto';
import {
  isRunnerKind,
  type AutomationTriggerKind,
  type AutomationTriggerOrigin,
  type AutomationTurnStreamEvent,
  type ProviderEgressConsentController,
  type RunnerHealthController,
  type RunnerPrefs,
  type VaultBridge,
} from '@centraid/app-engine';
import * as automation from '@centraid/automation';
import type { RunnerKind } from '../types.js';
import { parseAutomationAgentFailure, startLiveDispatch } from './run-automation-live-dispatch.js';

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
  vaultFor?: (
    appId: string,
    automationRef: string,
  ) => VaultBridge | undefined | Promise<VaultBridge | undefined>;
  /** Which CLI to drive. Defaults to codex. */
  runner?: RunnerKind;
  /**
   * Whether `runner` came from the user's own settings (`prefs`) or from the
   * automation's agent-writable manifest (`manifest`). Only the former is
   * consent for unattended egress; a manifest pin must still be a live ladder
   * member or carry an existing grant (#567 D13).
   */
  runnerSelectionSource?: 'prefs' | 'manifest';
  /**
   * Fallback model id/alias for this fire's `ctx.agent` calls, applied only
   * when the automation's manifest doesn't set `requires.model` (that always
   * wins — see `runFire`'s `OpenDispatchArgs.model`). The caller resolves
   * this from prefs (`model.<runnerKind>.automations` → `model.<runnerKind>.default`)
   * before calling in; `undefined` here means "no prefs fallback either" —
   * the backend sends no `model` field and uses its own built-in default.
   */
  model?: string;
  /** Semantic ACP configuration pins resolved for the automation subsystem. */
  configPins?: Readonly<Record<string, string>>;
  /** Ordered, pre-consented fallback runners for ctx.agent calls. */
  runnerLadder?: readonly RunnerKind[];
  /** Load launch settings/default pins for each failover rung. */
  runnerPrefsFor?: (runner: RunnerKind) => Promise<RunnerPrefs | undefined>;
  runnerHealth?: RunnerHealthController;
  runnerHealthContext?: string;
  /** Durable conversation×provider grant controller for unattended fires. */
  providerEgressConsent?: ProviderEgressConsentController;
  /** Resolve historical attachment hashes for scheduled handoff hydration. */
  hydrationAttachmentPath?: (hash: string) => string;
  /** Alert/monitor seam when a failed fire advances to the next rung. */
  onFailover?: (event: {
    automationRef: string;
    from: RunnerKind;
    to: RunnerKind;
    failureClass: string;
    failedRunId: string;
    nextRunId: string;
  }) => void;
  /** Hard timeout. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Optional logger. */
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Live run-stream sink (issue #158); forwarded to the fire spine. */
  onRunEvent?: (ev: AutomationTurnStreamEvent) => void;
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
  /** Human-readable trigger-gap/cursor note stored on the turn. */
  note?: string;
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
  /** Resolve each onFailure target's own automation pin. */
  resolveNestedRuntime?: (automationRef: string) => Promise<{
    runnerKind?: RunnerKind;
    model?: string;
    configPins?: Readonly<Record<string, string>>;
  }>;
}

/**
 * Single automation fire. Returns the run record + the handler outcome. A
 * missing automation app throws; a handler failure surfaces in
 * `outcome.ok === false`.
 */
export async function runAutomation(
  opts: RunAutomationOptions,
): Promise<{ outcome: automation.HandlerOutcome; record: automation.RunRecord }> {
  const primary: RunnerKind = opts.runner ?? 'codex';
  const ladder: RunnerKind[] = [];
  for (const kind of [primary, ...(opts.runnerLadder ?? [])]) {
    if (!ladder.includes(kind)) ladder.push(kind);
  }
  const baseRunId = opts.runId ?? `${opts.automationRef}:${Date.now()}:${randomUUID().slice(0, 8)}`;
  let last: { outcome: automation.HandlerOutcome; record: automation.RunRecord } | undefined;
  let failoverNotice: string | undefined;
  const condemned: string[] = [];

  for (let index = 0; index < ladder.length; index += 1) {
    const runner = ladder[index]!;
    const isPrimary = index === 0;
    // A known-open breaker is decided BEFORE the handler runs. `ctx.agent`
    // checks it too, but by then the handler's earlier side effects
    // (`ctx.fetch`, vault writes) have already landed and the next rung would
    // replay them. Scoped only when the caller supplied the same health
    // context the dispatcher uses — otherwise the keys would not match and the
    // dispatcher's check stays the only honest one.
    if (opts.runnerHealthContext && opts.runnerHealth) {
      const breaker = opts.runnerHealth.canAttempt(opts.runnerHealthContext, runner);
      if (!breaker.allowed) {
        const reason =
          `${runner} is circuit-broken (${breaker.failureClass ?? 'unknown'})` +
          `${breaker.breakerUntil ? ` until ${new Date(breaker.breakerUntil).toISOString()}` : ''}`;
        condemned.push(reason);
        const next = ladder[index + 1];
        opts.onLog?.(
          'warn',
          `${reason}; skipping it for ${opts.automationRef}` +
            `${next ? ` and continuing with ${next}` : ''}`,
        );
        failoverNotice = next
          ? `${reason}. Skipped without running the handler; continuing with ${next}.`
          : undefined;
        if (next) {
          opts.onFailover?.({
            automationRef: opts.automationRef,
            from: runner,
            to: next,
            failureClass: breaker.failureClass ?? 'unknown',
            failedRunId: index === 0 ? baseRunId : `${baseRunId}:failover:${index}:${runner}`,
            nextRunId: `${baseRunId}:failover:${index + 1}:${next}`,
          });
        }
        continue;
      }
    }
    const prefs = await opts.runnerPrefsFor?.(runner);
    const model = isPrimary ? opts.model : undefined;
    const configPins = isPrimary ? opts.configPins : prefs?.configPins;
    const runId = index === 0 ? baseRunId : `${baseRunId}:failover:${index}:${runner}`;
    const openDispatch: automation.OpenDispatch = (args) =>
      startLiveDispatch({
        workdir: args.workdir,
        runId: args.runId,
        automationRef: args.automationRef,
        journalDbFile: opts.journalDbFile,
        runner: isRunnerKind(args.runnerKind) ? args.runnerKind : runner,
        // A manifest capability tier, when present, still wins. Provider-
        // specific owner pins are deliberately cleared after the first rung.
        ...((args.model ?? model) ? { model: args.model ?? model } : {}),
        ...((args.configPins ?? configPins) ? { configPins: args.configPins ?? configPins } : {}),
        ...(opts.runnerPrefsFor ? { runnerPrefsFor: opts.runnerPrefsFor } : {}),
        ...(opts.runnerHealth ? { runnerHealth: opts.runnerHealth } : {}),
        ...(opts.runnerHealthContext ? { runnerHealthContext: opts.runnerHealthContext } : {}),
        ...(opts.providerEgressConsent
          ? { providerEgressConsent: opts.providerEgressConsent }
          : {}),
        ...(opts.hydrationAttachmentPath
          ? { hydrationAttachmentPath: opts.hydrationAttachmentPath }
          : {}),
        // A manifest-pinned primary is not user-authored consent; it may still
        // egress if the user's live failover ladder contains that runner, which
        // is exactly what `recordDerived('ladder', …)` verifies.
        consentSource: isPrimary && opts.runnerSelectionSource !== 'manifest' ? 'direct' : 'ladder',
        onLog: args.onLog,
      });

    const turnNote = [failoverNotice, opts.note].filter((part) => !!part).join(' ');

    last = await automation.runFire(
      {
        automationRef: opts.automationRef,
        runId,
        appsDir: opts.appsDir,
        journalDbFile: opts.journalDbFile,
        ...(opts.codeAppsDir ? { codeAppsDir: opts.codeAppsDir } : {}),
        ...(opts.vaultFor ? { vaultFor: opts.vaultFor } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.onLog ? { onLog: opts.onLog } : {}),
        runnerKind: runner,
        ...(model ? { model } : {}),
        ...(configPins ? { configPins } : {}),
        allowManifestProviderPins: isPrimary,
        ...(opts.onRunEvent ? { onRunEvent: opts.onRunEvent } : {}),
        ...(opts.triggerKind ? { triggerKind: opts.triggerKind } : {}),
        ...(opts.triggerOrigin ? { triggerOrigin: opts.triggerOrigin } : {}),
        // The caller's trigger-gap/cursor note stays on every rung; a failover
        // notice is additive evidence, not a replacement for it.
        ...(turnNote ? { note: turnNote } : {}),
        ...(failoverNotice ? { failoverNotice } : {}),
        ...(opts.input !== undefined ? { input: opts.input } : {}),
        ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
        ...(opts.failureDepth !== undefined ? { failureDepth: opts.failureDepth } : {}),
        ...(opts.resolveConnection ? { resolveConnection: opts.resolveConnection } : {}),
        ...(opts.resolveNestedRuntime ? { resolveNestedRuntime: opts.resolveNestedRuntime } : {}),
        deferOnFailure: (outcome) =>
          index < ladder.length - 1 && parseAutomationAgentFailure(outcome.error) !== undefined,
      },
      { openDispatch },
    );

    const failure = parseAutomationAgentFailure(last.outcome.error);
    const next = ladder[index + 1];
    if (!failure || !next) return last;
    const nextRunId = `${baseRunId}:failover:${index + 1}:${next}`;
    opts.onLog?.(
      'warn',
      `${runner} failed at automation fire boundary (${failure.failureClass}); ` +
        `re-entering ${opts.automationRef} with ${next} as ${nextRunId}`,
    );
    failoverNotice =
      `${runner} failed at the automation fire boundary (${failure.failureClass}). ` +
      `Continuing with ${next}; provider-specific model and effort pins were cleared.`;
    opts.onFailover?.({
      automationRef: opts.automationRef,
      from: runner,
      to: next,
      failureClass: failure.failureClass,
      failedRunId: runId,
      nextRunId,
    });
  }

  if (!last) {
    // Every rung was condemned before its handler could run. Surfacing this as
    // a throw keeps the caller's "failed before the ledger opened" path — which
    // closes the run stream and records the health error — instead of inventing
    // a run record for work that never started.
    throw new Error(
      `automation ${opts.automationRef}: no runner available — ${condemned.join('; ')}`,
    );
  }
  return last;
}
