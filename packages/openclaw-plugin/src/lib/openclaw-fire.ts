/*
 * One automation fire on the openclaw remote path (issue #90 model-B).
 *
 * `runOpenclawFire` is the openclaw counterpart to agent-runtime's
 * `runAutomationLocal`: it looks up the user-owned automation row in the
 * activity DB and runs its manifest prompt as an agent turn through
 * `runAutomationAgent`. The `AutomationAgentDispatcher` routes the turn
 * through the user's real provider via
 * `prepareSimpleCompletionModelForAgent` +
 * `completeWithPreparedSimpleCompletionModel`. `onFailure` cascade fires
 * the named sibling automation, depth-3 capped.
 */

import { randomUUID } from 'node:crypto';
import {
  AutomationRunsStore,
  AutomationStore,
  runAutomationAgent,
  type AutomationAgentDispatcher,
  type AutomationAgentEvent,
  type AutomationAgentOutcome,
  type AutomationTriggerKind,
  type DatabaseProvider,
} from '@centraid/runtime-core';
import {
  prepareSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel,
} from 'openclaw/plugin-sdk/simple-completion-runtime';

export interface OpenclawFireOptions {
  /** UUID of the automation to fire. */
  automationId: string;
  /** Activity-DB provider — holds the automation row + the run ledger. */
  automationDbProvider: DatabaseProvider;
  triggerKind: AutomationTriggerKind;
  failureDepth?: number;
  parentRunId?: string;
  input?: unknown;
}

type FireLog = { info(m: string): void; warn(m: string): void; error(m: string): void };

/**
 * Build the dispatcher that runs the automation agent turn through the
 * user's real provider. One completion of the manifest prompt; the
 * turn's token usage is captured onto the recorded `step` node.
 */
function makeOpenclawAgentDispatcher(): AutomationAgentDispatcher {
  return async function* dispatch(input): AsyncGenerator<AutomationAgentEvent> {
    const modelRef = input.requires.model;
    if (!modelRef) {
      throw new Error(
        'automation manifest.requires.model is unset — declare a model to run the agent turn',
      );
    }
    const startedAt = Date.now();
    const prepared = await prepareSimpleCompletionModelForAgent({
      cfg: getOpenClawConfig(),
      agentId: `centraid-automation:${input.automationId}`,
      modelRef,
    });
    if ('error' in prepared) throw new Error(`agent turn prepare failed: ${prepared.error}`);
    const out = await completeWithPreparedSimpleCompletionModel({
      model: prepared.model,
      auth: prepared.auth,
      context: { messages: [{ role: 'user', content: input.prompt, timestamp: Date.now() }] },
    });
    const endedAt = Date.now();

    const rawUsage = (out as unknown as { usage?: Record<string, unknown> }).usage;
    const usage: { inputTokens?: number; outputTokens?: number } = {};
    if (rawUsage && typeof rawUsage === 'object') {
      const n = (k: string): number | undefined =>
        typeof rawUsage[k] === 'number' ? (rawUsage[k] as number) : undefined;
      const input2 = n('inputTokens') ?? n('input_tokens');
      const output2 = n('outputTokens') ?? n('output_tokens');
      if (input2 !== undefined) usage.inputTokens = input2;
      if (output2 !== undefined) usage.outputTokens = output2;
    }

    yield {
      type: 'step',
      model: modelRef,
      provider: 'openclaw',
      usage,
      startedAt,
      endedAt,
    };

    const text = (out.content ?? [])
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('');
    yield { type: 'output', summary: text.slice(0, 500) || 'automation agent turn completed' };
  };
}

/** One automation fire. Returns the agent outcome plus the run id. */
export async function runOpenclawFire(
  opts: OpenclawFireOptions,
  log: FireLog,
): Promise<AutomationAgentOutcome & { runId: string }> {
  const runId = `${opts.automationId}:${Date.now()}:${randomUUID().slice(0, 8)}`;
  const failureDepth = opts.failureDepth ?? 0;

  const store = new AutomationStore(opts.automationDbProvider);
  const auto = store.get(opts.automationId);
  if (!auto) {
    return {
      ok: false,
      error: `automation ${opts.automationId}: not found in the activity DB`,
      stepCount: 0,
      toolCount: 0,
      runId,
    };
  }

  const runsStore = new AutomationRunsStore(opts.automationDbProvider);
  const outcome = await runAutomationAgent({
    automationId: opts.automationId,
    runId,
    prompt: auto.prompt,
    requires: auto.manifest.requires,
    dispatcher: makeOpenclawAgentDispatcher(),
    runsStore,
    triggerKind: opts.triggerKind,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
    ...(auto.manifest.outputSchema ? { outputSchema: auto.manifest.outputSchema } : {}),
    history: auto.manifest.history,
  });

  // onFailure cascade: fire the named sibling automation owned by the
  // same user, depth-3 capped.
  if (!outcome.ok && auto.manifest.onFailure) {
    if (failureDepth >= 3) {
      log.warn(`onFailure cascade for ${auto.name} aborted at depth ${failureDepth} (cap=3)`);
    } else {
      const next = store.getByName(auto.userId, auto.manifest.onFailure);
      if (!next) {
        log.warn(`onFailure target "${auto.manifest.onFailure}" not found for ${auto.name}`);
      } else {
        try {
          await runOpenclawFire(
            {
              automationId: next.id,
              automationDbProvider: opts.automationDbProvider,
              triggerKind: 'on_failure',
              failureDepth: failureDepth + 1,
              parentRunId: runId,
              input: { runId, automationName: auto.name, error: outcome.error ?? 'unknown error' },
            },
            log,
          );
        } catch (err) {
          log.error(
            `onFailure dispatch ${auto.manifest.onFailure} threw: ${err instanceof Error ? err.message : String(err)}`,
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
 * stashes it module-scoped (see `setOpenClawConfig`) so the agent turn
 * can route through the user's real provider auth.
 */
function getOpenClawConfig(): never {
  const cfg = openclawConfigRef.current;
  if (!cfg) {
    throw new Error(
      'centraid automation runner used before openclaw config was bound — plugin entry must call setOpenClawConfig() at registration',
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
