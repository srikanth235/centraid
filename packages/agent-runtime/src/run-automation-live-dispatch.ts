/*
 * Live `ctx.tool` / `ctx.agent` dispatch for the local automation
 * runner.
 *
 * Split out of `run-automation-local.ts` so that file can stay focused
 * on the per-fire lifecycle (manifest load, audit store, onFailure
 * cascade, replay vs. live branching). This module owns the "live"
 * side: the ephemeral mock-LLM server, the per-batch CLI subprocess
 * spawn, and the `ctx.agent` one-shot against the user's real provider.
 *
 * The replay side (`run-automation-replay.ts`) needs none of this — it
 * serves recorded `run_nodes` and never spawns a process.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  AutomationAgentDispatcher,
  AutomationDispatchContext,
  AutomationToolCall,
  AutomationToolDispatcher,
  AutomationToolResult,
} from '@centraid/runtime-core';
import { startMockLlmServer, type StagedTurn } from './mock-llm-server.js';
import {
  defaultSpawnCli,
  type LocalRunnerKind,
  type SpawnCli,
} from './run-automation-cli-spawn.js';

export interface LiveDispatchOptions {
  appDir: string;
  runId: string;
  runner: LocalRunnerKind;
  spawnCli: SpawnCli;
  /** Manifest `requires.tools` allowlist forwarded to the CLI. */
  toolsAllow: readonly string[];
  onLog: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export interface LiveDispatch {
  toolDispatcher: AutomationToolDispatcher;
  agentDispatcher: AutomationAgentDispatcher;
  /** Tear down the mock server + scratch dir. Safe to call once. */
  close(): Promise<void>;
}

/** Compose the per-batch CLI prompt the mock server expects. */
function buildBatchPrompt(appId: string, automationName: string): string {
  return `<<<centraid:${appId}:${automationName}>>>\nExecute the staged tool calls and return tool_result blocks.`;
}

/** Convert worker tool calls into the StagedTurn shape the mock returns. */
function batchToStagedTurn(calls: readonly AutomationToolCall[]): StagedTurn {
  return {
    stopReason: 'tool_use',
    toolUses: calls.map((c, idx) => ({
      id: `toolu_${idx}_${randomUUID().slice(0, 8)}`,
      name: c.name,
      input: c.args,
    })),
  };
}

/**
 * Stand up the live dispatch surface: an ephemeral mock-LLM server plus
 * a scratch dir. Returns the two dispatchers and a `close()` that tears
 * both down.
 */
export async function startLiveDispatch(opts: LiveDispatchOptions): Promise<LiveDispatch> {
  const scratchDir = path.join(opts.appDir, '.automation-scratch', opts.runId);
  await fs.mkdir(scratchDir, { recursive: true });

  const mock = await startMockLlmServer({
    onLog: opts.onLog,
    onToolResults: (dispatchId, results) => {
      const pending = batchAwaiters.get(dispatchId);
      if (pending) pending.deliverResults(results);
    },
  });

  interface BatchAwaiter {
    deliverResults(results: ReadonlyArray<{ id: string; content: string; isError: boolean }>): void;
  }
  const batchAwaiters = new Map<string, BatchAwaiter>();

  const toolDispatcher: AutomationToolDispatcher = async (
    calls: readonly AutomationToolCall[],
    ctx: AutomationDispatchContext,
  ): Promise<AutomationToolResult[]> => {
    const { dispatchId, bearerToken } = mock.mintDispatchToken();
    const turn = batchToStagedTurn(calls);
    mock.stageTurn(dispatchId, turn);

    const resultPromise = new Promise<
      ReadonlyArray<{ id: string; content: string; isError: boolean }>
    >((resolve) => {
      batchAwaiters.set(dispatchId, {
        deliverResults(results) {
          batchAwaiters.delete(dispatchId);
          resolve(results);
        },
      });
    });

    const spawnPromise = opts.spawnCli({
      kind: opts.runner,
      mockBaseUrl: mock.baseUrl,
      mockBearerToken: bearerToken,
      prompt: buildBatchPrompt(ctx.appId, ctx.automationName),
      toolsAllow: opts.toolsAllow,
      cwd: opts.appDir,
      scratchDir,
      abortSignal: ctx.abortSignal,
    });

    let collected: ReadonlyArray<{ id: string; content: string; isError: boolean }> | undefined;
    const results = await Promise.race([
      resultPromise.then((r) => {
        collected = r;
        return r;
      }),
      spawnPromise.then(() => undefined as undefined),
    ]);

    if (results) {
      try {
        mock.stageTurn(dispatchId, { text: 'ok', stopReason: 'end_turn' });
      } catch {
        /* the dispatch may have already cleared */
      }
    }

    const cliOutcome = await spawnPromise;
    batchAwaiters.delete(dispatchId);

    if (!cliOutcome.ok && !collected) {
      const errMsg = `CLI exited code=${cliOutcome.exitCode ?? '?'}\n${cliOutcome.stderr.slice(0, 2000)}`;
      return calls.map(() => ({ ok: false, error: errMsg }));
    }

    const captured = collected ?? [];
    const byIdx = new Map<number, { content: string; isError: boolean }>();
    const turnUses = turn.toolUses ?? [];
    for (const r of captured) {
      const useIdx = turnUses.findIndex((u) => u.id === r.id);
      if (useIdx >= 0) byIdx.set(useIdx, { content: r.content, isError: r.isError });
    }
    return calls.map((_call, idx) => {
      const r = byIdx.get(idx);
      if (!r) return { ok: false, error: 'no tool_result returned by host CLI' };
      if (r.isError) return { ok: false, error: r.content };
      try {
        return { ok: true, result: JSON.parse(r.content) as unknown };
      } catch {
        return { ok: true, result: r.content };
      }
    });
  };

  // ctx.agent routes to the user's REAL provider — no mock involvement.
  // One-shot prompt, no tools; JSON schema enforcement is post-hoc.
  const agentDispatcher: AutomationAgentDispatcher = async (call): Promise<unknown> => {
    const env = { ...process.env };
    const args =
      opts.runner === 'claude-code'
        ? ['-p', call.prompt, '--output-format', 'text', '--permission-mode', 'bypassPermissions']
        : ['exec', '--json', '--ask-for-approval', 'never', call.prompt];
    const proc = spawn(opts.runner === 'claude-code' ? 'claude' : 'codex', args, { env });
    const stdoutChunks: Buffer[] = [];
    proc.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    const result = await new Promise<{ ok: boolean; text: string; stderr: string }>((resolve) => {
      const stderrChunks: Buffer[] = [];
      proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
      proc.on('exit', (code) =>
        resolve({
          ok: code === 0,
          text: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
        }),
      );
      proc.on('error', (err) =>
        resolve({ ok: false, text: '', stderr: `spawn error: ${err.message}` }),
      );
    });
    if (!result.ok) {
      throw new Error(`ctx.agent CLI failed: ${result.stderr.slice(0, 2000)}`);
    }
    const text = result.text.trim();
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

  let closed = false;
  return {
    toolDispatcher,
    agentDispatcher,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await mock.close().catch(() => undefined);
      await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export { defaultSpawnCli };
