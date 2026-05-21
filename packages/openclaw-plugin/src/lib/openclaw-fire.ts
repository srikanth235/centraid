/*
 * One automation fire on the openclaw remote path (issue #91).
 *
 * `runOpenclawFire` is the openclaw counterpart to agent-runtime's
 * `runAutomationLocal`: it reads the automation project from disk and
 * runs its generated `handler.js` through `runAutomationHandler`.
 *
 *   - `toolDispatcher` routes `ctx.tool` through `callGatewayTool` (full
 *     harness MCP routing + audit + before-tool hooks for free).
 *   - `agentDispatcher` routes `ctx.agent` through the user's real
 *     provider via `prepareSimpleCompletionModelForAgent`.
 *   - `invokeDispatcher` re-enters this function for a sibling
 *     automation id.
 *   - `onFailure` cascade fires the named sibling, depth-3 capped.
 */

import { randomUUID } from 'node:crypto';
import {
  AutomationRunsStore,
  automationHandlerPath,
  readAutomationProject,
  runAutomationHandler,
  type AutomationDispatchContext,
  type AutomationHandlerOutcome,
  type AutomationInvokeDispatcher,
  type AutomationToolCall,
  type AutomationToolResult,
  type AutomationTriggerKind,
  type DatabaseProvider,
} from '@centraid/runtime-core';
import { callGatewayTool } from 'openclaw/plugin-sdk/agent-harness-runtime';
import {
  prepareSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel,
} from 'openclaw/plugin-sdk/simple-completion-runtime';

export interface OpenclawFireOptions {
  /** Id of the automation project to fire. */
  automationId: string;
  /** Directory holding the user's automation projects. */
  automationsDir: string;
  /** Activity-DB provider — holds the run ledger. */
  activityDbProvider: DatabaseProvider;
  triggerKind: AutomationTriggerKind;
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
  const runId = `${opts.automationId}:${Date.now()}:${randomUUID().slice(0, 8)}`;
  const failureDepth = opts.failureDepth ?? 0;

  const row = await readAutomationProject(opts.automationsDir, opts.automationId).catch(
    (err: unknown) => {
      log.error(
        `automation ${opts.automationId}: manifest load failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    },
  );
  if (!row) {
    return {
      ok: false,
      error: `automation ${opts.automationId}: not found under ${opts.automationsDir}`,
      logs: [],
      toolBatches: 0,
      agentCalls: 0,
      runId,
    };
  }
  const manifest = row.manifest;
  const runsStore = new AutomationRunsStore(opts.activityDbProvider);

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

  // ctx.invoke targets a sibling automation by id.
  const invokeDispatcher: AutomationInvokeDispatcher = async (targetId, args) => {
    if (!targetId || targetId.includes('/')) {
      throw new Error(`ctx.invoke("${targetId}"): target must be a sibling automation id`);
    }
    const child = await runOpenclawFire(
      {
        automationId: targetId,
        automationsDir: opts.automationsDir,
        activityDbProvider: opts.activityDbProvider,
        triggerKind: 'manual',
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
    automationId: opts.automationId,
    automationDir: row.dir,
    handlerFile: automationHandlerPath(opts.automationsDir, opts.automationId),
    runId,
    toolDispatcher,
    agentDispatcher,
    invokeDispatcher,
    runsStore,
    triggerKind: opts.triggerKind,
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
      try {
        await runOpenclawFire(
          {
            automationId: manifest.onFailure,
            automationsDir: opts.automationsDir,
            activityDbProvider: opts.activityDbProvider,
            triggerKind: 'on_failure',
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
