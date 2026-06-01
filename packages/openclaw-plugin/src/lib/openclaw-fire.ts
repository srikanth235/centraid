/*
 * One automation fire on the openclaw remote path (issue #98).
 *
 * `runOpenclawFire` is the openclaw counterpart to agent-runtime's
 * `runAutomationLocal`: it resolves an automation by its `<appId>/<id>`
 * handle — reading the *active version* of the owning app folder — and
 * runs the generated `handler.js` through `runAutomationHandler`.
 *
 *   - `toolDispatcher` routes `ctx.tool` through `callGatewayTool` (full
 *     harness MCP routing + audit + before-tool hooks for free).
 *   - `agentDispatcher` routes `ctx.agent` through the user's real
 *     provider via `prepareSimpleCompletionModelForAgent`.
 *   - `invokeDispatcher` re-enters this function for another automation
 *     by its handle (a bare id resolves within the same app).
 *   - `onFailure` cascade fires the named automation, depth-3 capped.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  AgentRunsStore,
  makeRuntimeDbProvider,
  type AutomationTriggerKind,
  type AutomationTriggerOrigin,
} from '@centraid/app-engine';
import type { AnalyticsStore } from '@centraid/analytics';
import {
  automationHandlerPath,
  formatAutomationRef,
  parseAutomationRef,
  readAppOwnedAutomation,
  runAutomationHandler,
  type AutomationDispatchContext,
  type AutomationHandlerOutcome,
  type AutomationInvokeDispatcher,
  type AutomationToolCall,
  type AutomationToolResult,
} from '@centraid/automation';
import { callGatewayTool } from 'openclaw/plugin-sdk/agent-harness-runtime';
import {
  prepareSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel,
} from 'openclaw/plugin-sdk/simple-completion-runtime';

export interface OpenclawFireOptions {
  /** `<appId>/<automationId>` handle of the automation to fire. */
  automationRef: string;
  /** Directory holding the gateway's app folders. */
  appsDir: string;
  /**
   * Central analytics store. When set, the per-app run ledger
   * write-throughs each finished run's summary to it (issue #98).
   */
  analytics?: AnalyticsStore;
  triggerKind: AutomationTriggerKind;
  /** Source that fired the run (`cron` / `webhook` / `manual`). */
  triggerOrigin?: AutomationTriggerOrigin;
  failureDepth?: number;
  parentRunId?: string;
  input?: unknown;
}

type FireLog = { info(m: string): void; warn(m: string): void; error(m: string): void };

/** One automation fire. Returns the handler outcome plus the run id. */
export async function runOpenclawFire(
  opts: OpenclawFireOptions,
  log: FireLog,
): Promise<AutomationHandlerOutcome & { runId: string }> {
  const runId = `${opts.automationRef}:${Date.now()}:${randomUUID().slice(0, 8)}`;
  const failureDepth = opts.failureDepth ?? 0;

  const parsed = parseAutomationRef(opts.automationRef);
  if (!parsed) {
    return {
      ok: false,
      error: `automation "${opts.automationRef}": not a valid <appId>/<id> handle`,
      logs: [],
      toolBatches: 0,
      agentCalls: 0,
      runId,
    };
  }
  const row = await readAppOwnedAutomation(opts.appsDir, parsed.appId, parsed.automationId).catch(
    (err: unknown) => {
      log.error(
        `automation ${opts.automationRef}: manifest load failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    },
  );
  if (!row) {
    return {
      ok: false,
      error: `automation ${opts.automationRef}: not found under ${opts.appsDir}`,
      logs: [],
      toolBatches: 0,
      agentCalls: 0,
      runId,
    };
  }
  const manifest = row.manifest;
  // The automation's run ledger is its app's per-app `runtime.sqlite`
  // (issue #98); `finishRun` write-throughs a summary to `analytics`.
  const runtimeDbPath = path.join(opts.appsDir, parsed.appId, 'runtime.sqlite');
  const runsStore = new AgentRunsStore(makeRuntimeDbProvider(runtimeDbPath), opts.analytics);

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
    const modelRef = manifest.requires.model;
    if (!modelRef) {
      throw new Error(
        'ctx.agent called but manifest.requires.model is unset — declare a model in the automation manifest',
      );
    }
    const prepared = await prepareSimpleCompletionModelForAgent({
      cfg: getOpenClawConfig(),
      agentId: `centraid-automation:${ctx.automationId}`,
      modelRef,
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

  // ctx.invoke targets another automation by handle — `<appId>/<id>`,
  // or a bare `<id>` resolved within the calling automation's app.
  const invokeDispatcher: AutomationInvokeDispatcher = async (targetId, args) => {
    const target = parseAutomationRef(targetId, parsed.appId);
    if (!target) {
      throw new Error(`ctx.invoke("${targetId}"): not a valid automation handle`);
    }
    const child = await runOpenclawFire(
      {
        automationRef: formatAutomationRef(target.appId, target.automationId),
        appsDir: opts.appsDir,
        ...(opts.analytics ? { analytics: opts.analytics } : {}),
        triggerKind: 'manual',
        ...(opts.triggerOrigin ? { triggerOrigin: opts.triggerOrigin } : {}),
        failureDepth,
        parentRunId: args.parentRunId,
        ...(args.input !== undefined ? { input: args.input } : {}),
      },
      log,
    );
    if (!child.ok) {
      throw Object.assign(new Error(`ctx.invoke("${targetId}") failed: ${child.error}`), {
        childRunId: child.runId,
      });
    }
    return { output: child.output, childRunId: child.runId };
  };

  const outcome = await runAutomationHandler({
    automationId: opts.automationRef,
    automationDir: row.dir,
    handlerFile: automationHandlerPath(row.dir),
    runId,
    toolDispatcher,
    agentDispatcher,
    invokeDispatcher,
    runsStore,
    triggerKind: opts.triggerKind,
    ...(opts.triggerOrigin ? { triggerOrigin: opts.triggerOrigin } : {}),
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
    ...(manifest.outputSchema ? { outputSchema: manifest.outputSchema } : {}),
    history: manifest.history,
    timeoutMs: 5 * 60 * 1000,
  });

  if (!outcome.ok && manifest.onFailure) {
    if (failureDepth >= 3) {
      log.warn(`onFailure cascade for ${row.name} aborted at depth ${failureDepth} (cap=3)`);
    } else {
      const failureInput = {
        runId,
        automationName: row.name,
        error: outcome.error ?? 'unknown error',
        nodes: runsStore.listNodes(runId).map((n) => ({
          ordinal: n.ordinal,
          kind: n.kind,
          name: n.name,
          ok: n.ok,
          ...(n.error !== undefined ? { error: n.error } : {}),
        })),
      };
      const failTarget = parseAutomationRef(manifest.onFailure, parsed.appId);
      if (!failTarget) {
        log.warn(
          `onFailure target "${manifest.onFailure}" is not a valid automation handle for ${row.name}`,
        );
      } else {
        try {
          await runOpenclawFire(
            {
              automationRef: formatAutomationRef(failTarget.appId, failTarget.automationId),
              appsDir: opts.appsDir,
              ...(opts.analytics ? { analytics: opts.analytics } : {}),
              triggerKind: 'on_failure',
              ...(opts.triggerOrigin ? { triggerOrigin: opts.triggerOrigin } : {}),
              failureDepth: failureDepth + 1,
              parentRunId: runId,
              input: failureInput,
            },
            log,
          );
        } catch (err) {
          log.error(
            `onFailure dispatch ${manifest.onFailure} threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  return { ...outcome, runId };
}

/**
 * Resolve the OpenClawConfig handle bound by the plugin entry. openclaw
 * makes its config available via the runtime context; the plugin entry
 * stashes it module-scoped (see `setOpenClawConfig`) so `ctx.agent` can
 * route through the user's real provider auth.
 */
function getOpenClawConfig(): never {
  const cfg = openclawConfigRef.current;
  if (!cfg) {
    throw new Error(
      'centraid-mock provider used before openclaw config was bound — plugin entry must call setOpenClawConfig() at registration',
    );
  }
  return cfg as never;
}

const openclawConfigRef: { current: unknown } = { current: undefined };

/**
 * Called by the plugin entry once `api.config` is in hand, before any
 * cron fire reaches our StreamFn.
 */
export function setOpenClawConfig(cfg: unknown): void {
  openclawConfigRef.current = cfg;
}
