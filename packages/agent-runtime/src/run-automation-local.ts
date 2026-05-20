/**
 * Local-side orchestrator for one automation fire.
 *
 * High-level flow (see issue #70 § Headless run path):
 *
 *   1. Load the manifest + resolve the handler file.
 *   2. Open the per-app `automations.sqlite` audit store.
 *   3. Build dispatchers:
 *        - Live mode: stand up the ephemeral mock-LLM server; each
 *          `ctx.tool` batch spawns one CLI subprocess, `ctx.agent`
 *          routes to the user's real provider. See
 *          `run-automation-live-dispatch.ts`.
 *        - Replay mode (`replayFromRunId`): serve `ctx.tool` / `ctx.agent`
 *          / `ctx.invoke` from a pinned run's recorded `run_nodes` — no
 *          subprocess, deterministic, offline. See
 *          `run-automation-replay.ts`. Used for builder iteration.
 *   4. Execute the JS handler via `runAutomationHandler`.
 *   5. On failure, fire the manifest's `onFailure` automation (depth-3
 *      capped). On success/failure, return the run record + outcome.
 *
 * `ctx.invoke` re-enters this function. Intra-app invokes link via
 * `parent_run_id`; cross-app invokes (`ctx.invoke('appId/name')`) resolve
 * the target app via the host-supplied `resolveApp` callback and run
 * against that app's own `automations.sqlite` (the `parent_run_id`
 * self-FK can't cross SQLite files, so cross-app children are unlinked).
 */

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  AutomationRunsStore,
  automationsDbPath,
  parseManifest,
  runAutomationHandler,
  type AutomationHandlerOutcome,
  type AutomationInvokeDispatcher,
  type AutomationManifest,
  type AutomationTriggerKind,
} from '@centraid/runtime-core';
import {
  startLiveDispatch,
  defaultSpawnCli,
  type LiveDispatch,
} from './run-automation-live-dispatch.js';
import { buildReplayDispatchers } from './run-automation-replay.js';
import {
  type LocalRunnerKind,
  type SpawnCli,
  type SpawnCliInput,
  type SpawnCliResult,
} from './run-automation-cli-spawn.js';

export {
  defaultSpawnCli,
  type LocalRunnerKind,
  type SpawnCli,
  type SpawnCliInput,
  type SpawnCliResult,
};

export interface RunAutomationLocalOptions {
  /** App id (folder name under the projects dir). */
  appId: string;
  /**
   * Absolute path to the app's *data* directory — where `data.sqlite`,
   * the scratch folder, and CLI cwd live. For uploaded apps this is the
   * persistent root that survives version swaps; for path-registered apps
   * (centraid CLI run from a project root) it's just the project dir.
   */
  appDir: string;
  /**
   * Absolute path to the app's *code* directory — where `automations/`
   * and `actions/` live. For uploaded apps this is the active version's
   * subdir (`<appDir>/versions/<activeVersion>/`); for path-registered
   * apps it's the same as `appDir`. Defaults to `appDir` when omitted.
   */
  codeDir?: string;
  /** Automation name. The manifest is loaded from `<codeDir>/automations/<name>.json`. */
  automationName: string;
  /** Which CLI to drive. Defaults to codex. */
  runner?: LocalRunnerKind;
  /** Hard timeout. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Override spawn for tests. */
  spawnCli?: SpawnCli;
  /** Optional logger. */
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Optional write notifier — called after the handler exits with the set of touched tables. */
  onWrite?: (tables: string[]) => void;
  /**
   * Trigger that caused this fire. Defaults to `'scheduled'`. Recursive
   * calls via `ctx.invoke` use `'manual'`; the onFailure dispatch loop
   * uses `'on_failure'`. Forced to `'replay'` when `replayFromRunId` is set.
   */
  triggerKind?: AutomationTriggerKind;
  /** Optional input payload (e.g. for sub-invocations / on_failure). */
  input?: unknown;
  /** Optional parent run id for sub-invocations. */
  parentRunId?: string;
  /**
   * Recursion guard for `onFailure` cascades. Defaults to 0. The runtime
   * refuses to fire a follow-up automation when this would push the
   * chain past depth 3 (issue #80 § Open question resolution).
   */
  failureDepth?: number;
  /**
   * Shared `AutomationRunsStore` for the per-app `automations.sqlite`.
   * When omitted, the host constructs one from `appDir`. Tests inject
   * a synthetic store to keep the file out of `appDir`.
   */
  runsStore?: AutomationRunsStore;
  /**
   * Pinned-data replay (issue #80 follow-up). When set, `ctx.tool` /
   * `ctx.agent` / `ctx.invoke` are served from the recorded `run_nodes`
   * of the named run instead of spawning CLIs — fast, offline, and
   * deterministic for builder iteration. Forces `triggerKind: 'replay'`.
   */
  replayFromRunId?: string;
  /**
   * Cross-app `ctx.invoke` resolver (issue #80 follow-up). Given a
   * registered app id, return its data + code dirs so an automation can
   * invoke a sibling automation in another app via `ctx.invoke('appId/name')`.
   * May be sync or async (the host typically resolves the active version
   * dir on disk). When omitted, cross-app invokes fail with a clear error.
   */
  resolveApp?: (
    appId: string,
  ) =>
    | { appDir: string; codeDir?: string }
    | undefined
    | Promise<{ appDir: string; codeDir?: string } | undefined>;
}

export interface AutomationRunRecord {
  appId: string;
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
 * Failures during preflight throw; failures during handler execution
 * surface in `outcome.ok === false`.
 */
export async function runAutomationLocal(
  opts: RunAutomationLocalOptions,
): Promise<{ outcome: AutomationHandlerOutcome; record: AutomationRunRecord }> {
  const runner: LocalRunnerKind = opts.runner ?? 'codex';
  const onLog = opts.onLog ?? (() => undefined);
  const spawnCli = opts.spawnCli ?? defaultSpawnCli;
  const runId = `${opts.appId}:${opts.automationName}:${Date.now()}:${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();

  const codeDir = opts.codeDir ?? opts.appDir;
  const manifestPath = path.join(codeDir, 'automations', `${opts.automationName}.json`);
  let manifest: AutomationManifest;
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    manifest = parseManifest(raw);
  } catch (err) {
    throw new Error(
      `automation ${opts.appId}/${opts.automationName}: failed to load manifest at ${manifestPath} — ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const handlerFile = path.join(codeDir, 'actions', manifest.action);
  await fs.access(handlerFile).catch(() => {
    throw new Error(
      `automation ${opts.appId}/${opts.automationName}: handler ${handlerFile} not found — re-run the builder to regenerate it`,
    );
  });

  // Per-app `automations.sqlite` — see issue #80. Constructed lazily;
  // the file isn't created until the first row lands.
  const runsStore = opts.runsStore ?? new AutomationRunsStore(automationsDbPath(opts.appDir));
  const failureDepth = opts.failureDepth ?? 0;
  const replay = opts.replayFromRunId !== undefined;
  const triggerKind: AutomationTriggerKind = replay ? 'replay' : (opts.triggerKind ?? 'scheduled');

  // Replay mode shares one node cursor across all three ctx surfaces.
  const replayDispatchers = replay
    ? buildReplayDispatchers(runsStore, opts.replayFromRunId as string)
    : undefined;

  // Live mode stands up the mock-LLM server + scratch dir.
  let live: LiveDispatch | undefined;
  if (!replay) {
    live = await startLiveDispatch({
      appDir: opts.appDir,
      runId,
      runner,
      spawnCli,
      toolsAllow: manifest.requires.tools ?? [],
      onLog,
    });
  }

  // ctx.invoke: fire a sibling automation and return its `output`.
  // Intra-app links the child via parent_run_id; `appId/name` targets a
  // different registered app (resolved via the host `resolveApp` hook).
  const liveInvoke: AutomationInvokeDispatcher = async (name, args) => {
    const slash = name.indexOf('/');
    const targetAppId = slash >= 0 ? name.slice(0, slash) : opts.appId;
    const targetName = slash >= 0 ? name.slice(slash + 1) : name;
    if (!targetName || targetName.includes('/')) {
      throw new Error(`ctx.invoke("${name}"): target must be "name" or "appId/name"`);
    }
    const crossApp = targetAppId !== opts.appId;

    let targetAppDir = opts.appDir;
    let targetCodeDir = opts.codeDir;
    let targetStore = runsStore;
    if (crossApp) {
      if (!opts.resolveApp) {
        throw new Error(
          `ctx.invoke("${name}"): cross-app invoke requires a host that wires resolveApp`,
        );
      }
      const resolved = await opts.resolveApp(targetAppId);
      if (!resolved) {
        throw new Error(`ctx.invoke("${name}"): app "${targetAppId}" is not registered`);
      }
      targetAppDir = resolved.appDir;
      targetCodeDir = resolved.codeDir;
      targetStore = new AutomationRunsStore(automationsDbPath(resolved.appDir));
    }

    let child: { outcome: AutomationHandlerOutcome; record: AutomationRunRecord };
    try {
      child = await runAutomationLocal({
        appId: targetAppId,
        appDir: targetAppDir,
        ...(targetCodeDir ? { codeDir: targetCodeDir } : {}),
        automationName: targetName,
        runner,
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        spawnCli,
        onLog,
        ...(opts.onWrite ? { onWrite: opts.onWrite } : {}),
        ...(opts.resolveApp ? { resolveApp: opts.resolveApp } : {}),
        triggerKind: 'manual',
        input: args.input,
        // The parent_run_id self-FK can't cross SQLite files — only link
        // intra-app children.
        ...(crossApp ? {} : { parentRunId: args.parentRunId }),
        failureDepth,
        runsStore: targetStore,
      });
    } finally {
      if (crossApp) targetStore.close();
    }
    if (!child.outcome.ok) {
      const e = new Error(
        `ctx.invoke("${name}") failed: ${child.outcome.error ?? 'unknown error'}`,
      ) as Error & { childRunId?: string };
      e.childRunId = child.record.runId;
      throw e;
    }
    return { output: child.outcome.output, childRunId: child.record.runId };
  };

  const outcome = await runAutomationHandler({
    app: { id: opts.appId, dir: opts.appDir },
    handlerFile,
    automationName: opts.automationName,
    runId,
    toolDispatcher: replayDispatchers ? replayDispatchers.toolDispatcher : live!.toolDispatcher,
    agentDispatcher: replayDispatchers ? replayDispatchers.agentDispatcher : live!.agentDispatcher,
    invokeDispatcher: replayDispatchers ? replayDispatchers.invokeDispatcher : liveInvoke,
    runsStore,
    triggerKind,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
    ...(manifest.outputSchema ? { outputSchema: manifest.outputSchema } : {}),
    history: manifest.history,
    timeoutMs: opts.timeoutMs ?? 5 * 60 * 1000,
    ...(opts.onWrite ? { onWrite: opts.onWrite } : {}),
  });

  await live?.close();

  // onFailure cascade: when the handler fails (incl. timeout / output
  // schema rejection) and the manifest names a follow-up automation,
  // fire it with the failed run as input. Capped at depth 3 so a
  // misconfigured pair can't loop forever. Skipped under replay — a
  // replayed fire must not trigger a fresh live automation.
  if (!replay && !outcome.ok && manifest.onFailure) {
    if (failureDepth >= 3) {
      onLog(
        'warn',
        `onFailure cascade for ${opts.appId}/${opts.automationName} aborted at depth ${failureDepth} (cap=3)`,
      );
    } else {
      const failureInput = {
        runId,
        automationName: opts.automationName,
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
        await runAutomationLocal({
          appId: opts.appId,
          appDir: opts.appDir,
          ...(opts.codeDir ? { codeDir: opts.codeDir } : {}),
          automationName: manifest.onFailure,
          runner,
          ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
          spawnCli,
          onLog,
          ...(opts.onWrite ? { onWrite: opts.onWrite } : {}),
          ...(opts.resolveApp ? { resolveApp: opts.resolveApp } : {}),
          triggerKind: 'on_failure',
          input: failureInput,
          parentRunId: runId,
          failureDepth: failureDepth + 1,
          runsStore,
        });
      } catch (err) {
        onLog(
          'error',
          `onFailure dispatch ${manifest.onFailure} threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  const endedAt = Date.now();
  const record: AutomationRunRecord = {
    appId: opts.appId,
    automationName: opts.automationName,
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
