/*
 * OpenClaw automation fire — now a thin adapter over the shared spine.
 *
 * Issue #166 (Phase 2): the per-fire orchestration — resolve the automation,
 * open its ledger, run `handler.js`, replay a resume journal, cascade
 * `onFailure`, and dispatch `ctx.invoke` — lives ONCE in app-engine's
 * `runAutomationFire`. The only host-specific piece is the live `ctx.tool` /
 * `ctx.agent` dispatch surface, injected as `openDispatch`. So OpenClaw no
 * longer reimplements the spine (the duplicated manifest-load + ledger +
 * onFailure + invoke glue is deleted); it just provides its in-process
 * dispatch surface and delegates to the spine — the same dependency inversion
 * the CLI runner (`runAutomationLocal`) uses.
 *
 * The dispatch surface:
 *   - `toolDispatcher` routes `ctx.tool` through `callGatewayTool` (full
 *     harness MCP routing + audit + before-tool hooks).
 *   - `agentDispatcher` routes `ctx.agent` through the user's real provider
 *     via `prepareSimpleCompletionModelForAgent`, at the manifest's declared
 *     model tier (`OpenAutomationDispatchArgs.model`).
 *
 * Because the spine drives the run, OpenClaw automations now get journaled
 * crash-resume (issue #166, Phase 3) and the lifted `ctx.invoke` for free.
 */

import {
  runAutomationFire,
  type AutomationDispatchContext,
  type AutomationDispatchSurface,
  type AutomationHandlerOutcome,
  type AutomationToolCall,
  type AutomationToolResult,
  type OpenAutomationDispatch,
  type OpenAutomationDispatchArgs,
} from '@centraid/automation-engine';
import {
  type AnalyticsStore,
  type AutomationTriggerKind,
  type AutomationTriggerOrigin,
} from '@centraid/app-engine';
import { callGatewayTool } from 'openclaw/plugin-sdk/agent-harness-runtime';
import {
  prepareSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel,
} from 'openclaw/plugin-sdk/simple-completion-runtime';

export interface OpenclawFireOptions {
  /** `<appId>/<automationId>` handle of the automation to fire. */
  automationRef: string;
  /**
   * Directory holding the gateway's per-app DATA folders
   * (`<appsDir>/<id>/runtime.sqlite` + `data.sqlite`). Stable across
   * version swaps — this is NOT where code lives (issue #137).
   */
  appsDir: string;
  /**
   * Directory holding the live app CODE on git-store `main`
   * (`<worktree>/apps/<id>/automations/...`). Resolved per fire from the
   * store's active-main link so a publish/rollback is picked up.
   */
  codeAppsDir: string;
  /**
   * Central analytics store. When set, the per-app run ledger
   * write-throughs each finished run's summary to it (issue #98).
   */
  analytics?: AnalyticsStore;
  triggerKind: AutomationTriggerKind;
  /** Source that fired the run (`cron` / `webhook` / `manual`). */
  triggerOrigin?: AutomationTriggerOrigin;
  /** Optional input payload (e.g. webhook body). */
  input?: unknown;
  /** Resume an interrupted fire from its journal (issue #166, Phase 3). */
  resumeFromRunId?: string;
}

type FireLog = { info(m: string): void; warn(m: string): void; error(m: string): void };

/**
 * The in-process OpenClaw dispatch surface: `ctx.tool` → `callGatewayTool`,
 * `ctx.agent` → simple-completion at the manifest's model tier. Injected into
 * `runAutomationFire` so the spine owns everything else.
 */
function makeOpenClawDispatch(): OpenAutomationDispatch {
  return (args: OpenAutomationDispatchArgs): Promise<AutomationDispatchSurface> => {
    const toolDispatcher = async (
      calls: readonly AutomationToolCall[],
      _ctx: AutomationDispatchContext,
    ): Promise<AutomationToolResult[]> =>
      Promise.all(
        calls.map(async (call) => {
          try {
            const out = await callGatewayTool(call.name, {}, call.args);
            return { ok: true, result: out } satisfies AutomationToolResult;
          } catch (err) {
            return {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            } satisfies AutomationToolResult;
          }
        }),
      );

    const agentDispatcher = async (
      call: { prompt: string; json?: unknown },
      ctx: AutomationDispatchContext,
    ): Promise<unknown> => {
      if (!args.model) {
        throw new Error(
          'ctx.agent called but manifest.requires.model is unset — declare a model in the automation manifest',
        );
      }
      const prepared = await prepareSimpleCompletionModelForAgent({
        cfg: getOpenClawConfig(),
        agentId: `centraid-automation:${ctx.automationId}`,
        modelRef: args.model,
      });
      if ('error' in prepared) throw new Error(`ctx.agent prepare failed: ${prepared.error}`);
      const out = await completeWithPreparedSimpleCompletionModel({
        model: prepared.model,
        auth: prepared.auth,
        context: { messages: [{ role: 'user', content: call.prompt, timestamp: Date.now() }] },
      });
      const text = (out.content ?? [])
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('');
      if (!call.json) return text;
      try {
        return JSON.parse(text) as unknown;
      } catch (err) {
        throw new Error(
          `ctx.agent expected JSON but got: ${text.slice(0, 500)} (${err instanceof Error ? err.message : String(err)})`,
          { cause: err },
        );
      }
    };

    return Promise.resolve({
      toolDispatcher,
      agentDispatcher,
      // In-process — nothing to tear down per fire.
      close: async () => undefined,
    });
  };
}

/** One automation fire on the OpenClaw host. Returns the handler outcome plus
 *  the run id (preserved for the webhook route + callers). */
export async function runOpenclawFire(
  opts: OpenclawFireOptions,
  log: FireLog,
): Promise<AutomationHandlerOutcome & { runId: string }> {
  const { outcome, record } = await runAutomationFire(
    {
      automationRef: opts.automationRef,
      appsDir: opts.appsDir,
      codeAppsDir: opts.codeAppsDir,
      ...(opts.analytics ? { analytics: opts.analytics } : {}),
      onLog: (level, msg) => log[level](msg),
      triggerKind: opts.triggerKind,
      ...(opts.triggerOrigin ? { triggerOrigin: opts.triggerOrigin } : {}),
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      ...(opts.resumeFromRunId ? { resumeFromRunId: opts.resumeFromRunId } : {}),
    },
    { openDispatch: makeOpenClawDispatch() },
  );
  return { ...outcome, runId: record.runId };
}

/**
 * Resolve the OpenClawConfig handle bound by the plugin entry. openclaw makes
 * its config available via the runtime context; the plugin entry stashes it
 * module-scoped (see `setOpenClawConfig`) so `ctx.agent` can route through the
 * user's real provider auth.
 */
function getOpenClawConfig(): never {
  const cfg = openclawConfigRef.current;
  if (!cfg) {
    throw new Error(
      'centraid ctx.agent used before openclaw config was bound — plugin entry must call setOpenClawConfig() at registration',
    );
  }
  return cfg as never;
}

const openclawConfigRef: { current: unknown } = { current: undefined };

/**
 * Called by the plugin entry once `api.config` is in hand, before any cron
 * fire reaches our StreamFn.
 */
export function setOpenClawConfig(cfg: unknown): void {
  openclawConfigRef.current = cfg;
}
