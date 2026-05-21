/**
 * Local-side orchestrator for one automation fire (issue #91).
 *
 * Flow:
 *   1. Read the automation project (`automation.json` + `handler.js`)
 *      from `automationsDir` by its id.
 *   2. Build the activity-DB-backed run ledger store.
 *   3. Stand up the live `ctx.tool` / `ctx.agent` dispatch surface
 *      (mock-LLM server + CLI spawn) and run the project's generated
 *      `handler.js` in a worker thread via `runAutomationHandler`.
 *   4. On failure, fire the manifest's `onFailure` automation
 *      (depth-3 capped). Return the run record + outcome.
 */

import { randomUUID } from 'node:crypto';
import {
  AutomationRunsStore,
  automationHandlerPath,
  readAutomationProject,
  runAutomationHandler,
  type AutomationHandlerOutcome,
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
import { startLiveDispatch } from './run-automation-live-dispatch.js';

export {
  defaultSpawnCli,
  type LocalRunnerKind,
  type SpawnCli,
  type SpawnCliInput,
  type SpawnCliResult,
};

export interface RunAutomationLocalOptions {
  /** Id of the automation project to fire. */
  automationId: string;
  /** Directory holding the user's automation projects. */
  automationsDir: string;
  /** Activity-DB provider — holds the run ledger. */
  activityDb: DatabaseProvider;
  /** Which CLI to drive. Defaults to codex. */
  runner?: LocalRunnerKind;
  /** Hard timeout. Defaults to 5 minutes. */
  timeoutMs?: number;
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
  toolBatches: number;
  agentCalls: number;
}

/**
 * Single automation fire. Returns the run record + the handler outcome.
 * A missing automation project throws; a handler failure surfaces in
 * `outcome.ok === false`.
 */
export async function runAutomationLocal(
  opts: RunAutomationLocalOptions,
): Promise<{ outcome: AutomationHandlerOutcome; record: AutomationRunRecord }> {
  const onLog = opts.onLog ?? (() => undefined);
  const runner: LocalRunnerKind = opts.runner ?? 'codex';

  const row = await readAutomationProject(opts.automationsDir, opts.automationId);
  if (!row) {
    throw new Error(`automation ${opts.automationId}: not found under ${opts.automationsDir}`);
  }

  const runsStore = new AutomationRunsStore(opts.activityDb);
  const runId = `${opts.automationId}:${Date.now()}:${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const failureDepth = opts.failureDepth ?? 0;

  const dispatch = await startLiveDispatch({
    workdir: row.dir,
    automationId: opts.automationId,
    runId,
    runner,
    spawnCli: opts.spawnCli ?? defaultSpawnCli,
    toolsAllow: row.manifest.requires.tools ?? [],
    onLog,
  });

  let outcome: AutomationHandlerOutcome;
  try {
    outcome = await runAutomationHandler({
      automationId: opts.automationId,
      automationDir: row.dir,
      handlerFile: automationHandlerPath(opts.automationsDir, opts.automationId),
      runId,
      toolDispatcher: dispatch.toolDispatcher,
      agentDispatcher: dispatch.agentDispatcher,
      runsStore,
      triggerKind: opts.triggerKind ?? 'scheduled',
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
  // follow-up automation, fire it with the failed run as input. Capped
  // at depth 3.
  if (!outcome.ok && row.manifest.onFailure) {
    if (failureDepth >= 3) {
      onLog('warn', `onFailure cascade for ${row.name} aborted at depth ${failureDepth} (cap=3)`);
    } else {
      const next = await readAutomationProject(opts.automationsDir, row.manifest.onFailure);
      if (!next) {
        onLog('warn', `onFailure target "${row.manifest.onFailure}" not found for ${row.name}`);
      } else {
        try {
          await runAutomationLocal({
            automationId: next.id,
            automationsDir: opts.automationsDir,
            activityDb: opts.activityDb,
            runner,
            ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
            ...(opts.spawnCli ? { spawnCli: opts.spawnCli } : {}),
            onLog,
            triggerKind: 'on_failure',
            input: { runId, automationName: row.name, error: outcome.error ?? 'unknown error' },
            parentRunId: runId,
            failureDepth: failureDepth + 1,
          });
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
  const record: AutomationRunRecord = {
    automationId: opts.automationId,
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
