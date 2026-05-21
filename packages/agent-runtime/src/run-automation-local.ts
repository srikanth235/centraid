/**
 * Local-side orchestrator for one automation fire (issue #90 model-B).
 *
 * Flow:
 *   1. Look up the user-owned automation row (manifest included) in the
 *      activity DB by its UUID.
 *   2. Build the activity-DB-backed run ledger store.
 *   3. Run the manifest prompt as an agent turn via `runAutomationAgent`,
 *      driving the codex / claude CLI through the local dispatcher.
 *   4. On failure, fire the manifest's `onFailure` automation (depth-3
 *      capped). Return the run record + outcome.
 *
 * There is no JS handler, no per-app code dir, and no mock-LLM server —
 * the manifest prompt goes straight to the agent CLI against the user's
 * own provider auth.
 */

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  AutomationRunsStore,
  AutomationStore,
  runAutomationAgent,
  type AutomationAgentOutcome,
  type AutomationTriggerKind,
  type DatabaseProvider,
} from '@centraid/runtime-core';
import {
  defaultSpawnCli,
  type LocalRunnerKind,
  type SpawnCli,
  type SpawnCliInput,
  type SpawnCliResult,
} from './run-automation-cli-spawn.js';
import { makeLocalAgentDispatcher } from './run-automation-agent-dispatch.js';

export {
  defaultSpawnCli,
  type LocalRunnerKind,
  type SpawnCli,
  type SpawnCliInput,
  type SpawnCliResult,
};

export interface RunAutomationLocalOptions {
  /** UUID of the automation to fire. */
  automationId: string;
  /** Activity-DB provider — holds the automation row + the run ledger. */
  automationDb: DatabaseProvider;
  /** Workspace dir the agent CLI runs in. Defaults to a fresh temp dir. */
  workdir?: string;
  /** Which CLI to drive. Defaults to codex. */
  runner?: LocalRunnerKind;
  /** Hard timeout. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Override the CLI binary path. */
  binPath?: string;
  /** Override spawn for tests. */
  spawnCli?: SpawnCli;
  /** Optional logger. */
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /**
   * Trigger that caused this fire. Defaults to `'scheduled'`. The
   * onFailure dispatch loop uses `'on_failure'`.
   */
  triggerKind?: AutomationTriggerKind;
  /** Optional input payload (e.g. for on_failure dispatch). */
  input?: unknown;
  /** Optional parent run id for the onFailure sub-run DAG link. */
  parentRunId?: string;
  /**
   * Recursion guard for `onFailure` cascades. Defaults to 0 — the
   * runtime refuses to push the chain past depth 3.
   */
  failureDepth?: number;
}

export interface AutomationRunRecord {
  automationId: string;
  automationName: string;
  runId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  ok: boolean;
  error?: string;
  stepCount: number;
  toolCount: number;
}

/**
 * Single automation fire. Returns the run record + the agent outcome.
 * A missing automation row throws; an agent-turn failure surfaces in
 * `outcome.ok === false`.
 */
export async function runAutomationLocal(
  opts: RunAutomationLocalOptions,
): Promise<{ outcome: AutomationAgentOutcome; record: AutomationRunRecord }> {
  const onLog = opts.onLog ?? (() => undefined);
  const runner: LocalRunnerKind = opts.runner ?? 'codex';

  const store = new AutomationStore(opts.automationDb);
  const auto = store.get(opts.automationId);
  if (!auto) {
    throw new Error(`automation ${opts.automationId}: not found in the activity DB`);
  }

  const runsStore = new AutomationRunsStore(opts.automationDb);
  const runId = `${opts.automationId}:${Date.now()}:${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const failureDepth = opts.failureDepth ?? 0;

  const workdir =
    opts.workdir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-automation-')));
  const dispatcher = makeLocalAgentDispatcher({
    runner,
    cwd: workdir,
    ...(opts.binPath ? { binPath: opts.binPath } : {}),
    ...(opts.spawnCli ? { spawnCli: opts.spawnCli } : {}),
    onLog,
  });

  const outcome = await runAutomationAgent({
    automationId: opts.automationId,
    runId,
    prompt: auto.prompt,
    requires: auto.manifest.requires,
    dispatcher,
    runsStore,
    triggerKind: opts.triggerKind ?? 'scheduled',
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
    ...(auto.manifest.outputSchema ? { outputSchema: auto.manifest.outputSchema } : {}),
    history: auto.manifest.history,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });

  // onFailure cascade: when the turn fails and the manifest names a
  // follow-up automation owned by the same user, fire it with the
  // failed run as input. Capped at depth 3.
  if (!outcome.ok && auto.manifest.onFailure) {
    if (failureDepth >= 3) {
      onLog('warn', `onFailure cascade for ${auto.name} aborted at depth ${failureDepth} (cap=3)`);
    } else {
      const next = store.getByName(auto.userId, auto.manifest.onFailure);
      if (!next) {
        onLog('warn', `onFailure target "${auto.manifest.onFailure}" not found for ${auto.name}`);
      } else {
        try {
          await runAutomationLocal({
            automationId: next.id,
            automationDb: opts.automationDb,
            ...(opts.workdir ? { workdir: opts.workdir } : {}),
            runner,
            ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
            ...(opts.binPath ? { binPath: opts.binPath } : {}),
            ...(opts.spawnCli ? { spawnCli: opts.spawnCli } : {}),
            onLog,
            triggerKind: 'on_failure',
            input: { runId, automationName: auto.name, error: outcome.error ?? 'unknown error' },
            parentRunId: runId,
            failureDepth: failureDepth + 1,
          });
        } catch (err) {
          onLog(
            'error',
            `onFailure dispatch ${auto.manifest.onFailure} threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  const endedAt = Date.now();
  const record: AutomationRunRecord = {
    automationId: opts.automationId,
    automationName: auto.name,
    runId,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    ok: outcome.ok,
    ...(outcome.error ? { error: outcome.error } : {}),
    stepCount: outcome.stepCount,
    toolCount: outcome.toolCount,
  };
  return { outcome, record };
}
