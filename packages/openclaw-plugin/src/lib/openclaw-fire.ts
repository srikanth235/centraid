/*
 * One automation fire on the openclaw remote path.
 *
 * Split out of `automations-provider.ts` (which owns the provider
 * descriptor + StreamFn glue) so that file stays under the size cap and
 * the per-fire lifecycle is legible. `runOpenclawFire` is the openclaw
 * counterpart to agent-runtime's `runAutomationLocal`:
 *
 *   - `toolDispatcher` routes `ctx.tool` through `callGatewayTool` (full
 *     harness MCP routing + audit + before-tool hooks for free).
 *   - `agentDispatcher` routes `ctx.agent` through the user's real
 *     provider via `prepareSimpleCompletionModelForAgent`.
 *   - `invokeDispatcher` re-enters this function. `ctx.invoke('name')`
 *     stays intra-app; `ctx.invoke('appId/name')` resolves the target
 *     app's dir through `resolveAppDir` (the same registry the desktop
 *     and mobile use to list apps). Run audit for every app lives in
 *     one central gateway DB, so a cross-app child run links its
 *     `parent_run_id` into the same DAG as an intra-app one — the
 *     child is recorded under the target app via `runsStore.forApp`.
 *   - `onFailure` cascade fires the named sibling, depth-3 capped.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  parseManifest,
  runAutomationHandler,
  type AutomationDispatchContext,
  type AutomationHandlerOutcome,
  type AutomationInvokeDispatcher,
  type AutomationManifest,
  type AutomationRunsStore,
  type AutomationToolCall,
  type AutomationToolResult,
  type AutomationTriggerKind,
} from '@centraid/runtime-core';
import { callGatewayTool } from 'openclaw/plugin-sdk/agent-harness-runtime';
import {
  prepareSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel,
} from 'openclaw/plugin-sdk/simple-completion-runtime';

export interface OpenclawFireOptions {
  appId: string;
  appDir: string;
  automationName: string;
  triggerKind: AutomationTriggerKind;
  failureDepth: number;
  runsStore: AutomationRunsStore;
  /** Resolve any registered app's disk dir — enables cross-app `ctx.invoke`. */
  resolveAppDir: (appId: string) => string | undefined;
  parentRunId?: string;
  input?: unknown;
}

type FireLog = { info(m: string): void; warn(m: string): void; error(m: string): void };

/** One automation fire. Returns the handler outcome plus the run id. */
export async function runOpenclawFire(
  opts: OpenclawFireOptions,
  log: FireLog,
): Promise<AutomationHandlerOutcome & { runId: string }> {
  const manifestPath = path.join(opts.appDir, 'automations', `${opts.automationName}.json`);
  const runId = `${opts.appId}:${opts.automationName}:${Date.now()}:${randomUUID().slice(0, 8)}`;
  let manifest: AutomationManifest;
  try {
    manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      error: `failed to load manifest ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
      logs: [],
      toolBatches: 0,
      agentCalls: 0,
      runId,
    };
  }
  const handlerFile = path.join(opts.appDir, 'actions', manifest.action);

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
    _ctx: AutomationDispatchContext,
  ): Promise<unknown> => {
    const modelRef = manifest.requires.model;
    if (!modelRef) {
      throw new Error(
        'ctx.agent called but manifest.requires.model is unset — declare a model in the automation manifest',
      );
    }
    const prepared = await prepareSimpleCompletionModelForAgent({
      cfg: getOpenClawConfig(),
      agentId: `centraid-automation:${_ctx.appId}:${_ctx.automationName}`,
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

  const invokeDispatcher: AutomationInvokeDispatcher = async (name, args) => {
    const slash = name.indexOf('/');
    const targetAppId = slash >= 0 ? name.slice(0, slash) : opts.appId;
    const targetName = slash >= 0 ? name.slice(slash + 1) : name;
    if (!targetName || targetName.includes('/')) {
      throw new Error(`ctx.invoke("${name}"): target must be "name" or "appId/name"`);
    }
    const crossApp = targetAppId !== opts.appId;
    let targetAppDir = opts.appDir;
    let targetStore = opts.runsStore;
    if (crossApp) {
      const dir = opts.resolveAppDir(targetAppId);
      if (!dir) throw new Error(`ctx.invoke("${name}"): app "${targetAppId}" is not registered`);
      targetAppDir = dir;
      // Same gateway DB, target app's origin id — the child run lands
      // under the target app and links its parent_run_id into one DAG.
      targetStore = opts.runsStore.forApp(targetAppId);
    }
    const child = await runOpenclawFire(
      {
        appId: targetAppId,
        appDir: targetAppDir,
        automationName: targetName,
        triggerKind: 'manual',
        failureDepth: opts.failureDepth,
        runsStore: targetStore,
        resolveAppDir: opts.resolveAppDir,
        // All run audit lives in one gateway DB, so the parent_run_id
        // self-FK links a cross-app child too.
        parentRunId: args.parentRunId,
        ...(args.input !== undefined ? { input: args.input } : {}),
      },
      log,
    );
    if (!child.ok) {
      throw Object.assign(new Error(`ctx.invoke("${name}") failed: ${child.error}`), {
        childRunId: child.runId,
      });
    }
    return { output: child.output, childRunId: child.runId };
  };

  const outcome = await runAutomationHandler({
    app: { id: opts.appId, dir: opts.appDir },
    handlerFile,
    automationName: opts.automationName,
    runId,
    toolDispatcher,
    agentDispatcher,
    invokeDispatcher,
    runsStore: opts.runsStore,
    triggerKind: opts.triggerKind,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
    ...(manifest.outputSchema ? { outputSchema: manifest.outputSchema } : {}),
    history: manifest.history,
    timeoutMs: 5 * 60 * 1000,
  });

  if (!outcome.ok && manifest.onFailure) {
    if (opts.failureDepth >= 3) {
      log.warn(
        `onFailure cascade for ${opts.appId}/${opts.automationName} aborted at depth ${opts.failureDepth} (cap=3)`,
      );
    } else {
      const failureInput = {
        runId,
        automationName: opts.automationName,
        error: outcome.error ?? 'unknown error',
        nodes: opts.runsStore.listNodes(runId).map((n) => ({
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
            appId: opts.appId,
            appDir: opts.appDir,
            automationName: manifest.onFailure,
            triggerKind: 'on_failure',
            failureDepth: opts.failureDepth + 1,
            runsStore: opts.runsStore,
            resolveAppDir: opts.resolveAppDir,
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
