/*
 * Live `ctx.tool` / `ctx.agent` dispatch for the local automation
 * runner.
 *
 * Split out of `run-automation-local.ts` so that file can stay focused
 * on the per-fire lifecycle (manifest load, audit store, onFailure
 * cascade). This module owns the "live" side: the ephemeral mock-LLM
 * server, the per-batch CLI subprocess spawn, and the `ctx.agent`
 * one-shot against the user's real provider.
 *
 * Issue #91: an automation is a standalone app — the CLI runs with
 * the app directory as cwd, and the dispatch context carries the
 * automation id (no owning app).
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  AutomationAgentDispatcher,
  AutomationDispatchContext,
  AutomationToolCall,
  AutomationToolDispatcher,
  AutomationToolResult,
} from '@centraid/automation';
import { startMockLlmServer, type StagedTurn } from './mock-llm-server.js';
import { runClaudeSdkTurn } from './claude-sdk.js';
import {
  defaultSpawnCli,
  type LocalRunnerKind,
  type SpawnCli,
} from './run-automation-cli-spawn.js';

export interface LiveDispatchOptions {
  /** The automation app directory — also the CLI's cwd. */
  workdir: string;
  /** Id of the automation being fired. */
  automationId: string;
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
function buildBatchPrompt(automationId: string): string {
  return `<<<centraid:${automationId}>>>\nExecute the staged tool calls and return tool_result blocks.`;
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

/** Drain a spawned CLI's stdout/stderr and resolve once it exits. */
async function collectProcess(
  proc: ChildProcess,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  proc.stdout?.on('data', (c: Buffer) => out.push(c));
  proc.stderr?.on('data', (c: Buffer) => err.push(c));
  return await new Promise((resolve) => {
    proc.on('exit', (code) =>
      resolve({
        ok: code === 0,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
    proc.on('error', (e) =>
      resolve({ ok: false, stdout: '', stderr: `spawn error: ${e.message}` }),
    );
  });
}

/**
 * OpenAI structured outputs reject any object schema that doesn't
 * explicitly set `additionalProperties: false`. Codex forwards the
 * `--output-schema` file verbatim, so we deep-normalise the schema an
 * automation passes to `ctx.agent({ json })` before writing it out.
 */
function normalizeOutputSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(normalizeOutputSchema);
  if (schema && typeof schema === 'object') {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      obj[k] = normalizeOutputSchema(v);
    }
    if (obj.type === 'object' && obj.additionalProperties === undefined) {
      obj.additionalProperties = false;
    }
    return obj;
  }
  return schema;
}

/**
 * Coerce a CLI's final answer into the shape `ctx.agent` promised: a
 * plain prompt returns the text as-is; a `json` prompt parses it,
 * tolerating a ```json fence the model may wrap around the object.
 */
function coerceAgentAnswer(text: string, json: unknown): unknown {
  const trimmed = text.trim();
  if (!json) return trimmed;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  try {
    return JSON.parse(candidate) as unknown;
  } catch (err) {
    throw new Error(
      `ctx.agent expected JSON but got: ${trimmed.slice(0, 500)} (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
}

/**
 * Stand up the live dispatch surface: an ephemeral mock-LLM server plus
 * a scratch dir. Returns the two dispatchers and a `close()` that tears
 * both down.
 */
export async function startLiveDispatch(opts: LiveDispatchOptions): Promise<LiveDispatch> {
  const scratchDir = path.join(opts.workdir, '.automation-scratch', opts.runId);
  await fs.mkdir(scratchDir, { recursive: true });

  interface BatchAwaiter {
    deliverResults(results: ReadonlyArray<{ id: string; content: string; isError: boolean }>): void;
  }
  const batchAwaiters = new Map<string, BatchAwaiter>();

  // Per-call timing (issue #158, Phase 3): the mock signals when it hands the
  // CLI a tool (start) and when each result lands (finish), keyed by dispatch
  // then tool-use id. Lets each tool node record its real execution window
  // instead of the batch span that also covers CLI spawn/teardown.
  const toolTiming = new Map<string, Map<string, { startedAt?: number; endedAt?: number }>>();
  const timingFor = (dispatchId: string, id: string): { startedAt?: number; endedAt?: number } => {
    let perDispatch = toolTiming.get(dispatchId);
    if (!perDispatch) {
      perDispatch = new Map();
      toolTiming.set(dispatchId, perDispatch);
    }
    let entry = perDispatch.get(id);
    if (!entry) {
      entry = {};
      perDispatch.set(id, entry);
    }
    return entry;
  };

  const mock = await startMockLlmServer({
    onLog: opts.onLog,
    onToolStart: (dispatchId, toolUses) => {
      const now = Date.now();
      for (const u of toolUses) timingFor(dispatchId, u.id).startedAt = now;
    },
    onToolResults: (dispatchId, results) => {
      const now = Date.now();
      for (const r of results) timingFor(dispatchId, r.id).endedAt = now;
      const pending = batchAwaiters.get(dispatchId);
      if (pending) pending.deliverResults(results);
    },
  });

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
      prompt: buildBatchPrompt(ctx.automationId),
      toolsAllow: opts.toolsAllow,
      cwd: opts.workdir,
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
    const perDispatch = toolTiming.get(dispatchId);
    toolTiming.delete(dispatchId);
    const timing = (idx: number): { startedAt?: number; endedAt?: number } => {
      const t = perDispatch?.get(turnUses[idx]?.id ?? '');
      return {
        ...(t?.startedAt !== undefined ? { startedAt: t.startedAt } : {}),
        ...(t?.endedAt !== undefined ? { endedAt: t.endedAt } : {}),
      };
    };
    return calls.map((_call, idx) => {
      const r = byIdx.get(idx);
      if (!r) return { ok: false, error: 'no tool_result returned by host CLI' };
      if (r.isError) return { ok: false, error: r.content, ...timing(idx) };
      try {
        return { ok: true, result: JSON.parse(r.content) as unknown, ...timing(idx) };
      } catch {
        return { ok: true, result: r.content, ...timing(idx) };
      }
    });
  };

  // ctx.agent routes to the user's REAL provider via the local CLI —
  // no mock involvement. The final answer is read from a file the CLI
  // writes (codex `--output-last-message`) rather than parsed out of
  // the event stream, and `--output-schema` enforces the JSON shape.
  const agentDispatcher: AutomationAgentDispatcher = async (call, ctx): Promise<unknown> => {
    const env = { ...process.env };
    // `stdin: 'ignore'` is load-bearing: `codex exec` treats an open
    // stdin pipe as an appended `<stdin>` instruction block and blocks
    // until EOF — leaving it piped hangs the call until the run times
    // out. `signal` lets a run timeout kill the CLI child too.
    const spawnOpts: SpawnOptions = {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: ctx.abortSignal,
    };

    if (opts.runner === 'claude-code') {
      // Phase 2 (issue #158): route ctx.agent through the Claude SDK chat
      // adapter — the same one chat uses — instead of a collect-on-exit
      // `claude -p` spawn. The turn now streams token-level ChatStreamEvents
      // (forwarded to the run bus as node.delta via `call.onEvent`). The
      // return contract is unchanged: accumulate the final text and coerce
      // it exactly as before. `bypassPermissions` preserves the old
      // non-interactive behavior (a detached turn must not block on a prompt).
      let finalText = '';
      let errorMessage: string | undefined;
      await runClaudeSdkTurn({
        cwd: opts.workdir,
        message: call.prompt,
        extraSystemPrompt: '',
        permissionMode: 'bypassPermissions',
        abortSignal: ctx.abortSignal,
        onEvent: (ev) => {
          if (ev.type === 'final') finalText = ev.text;
          else if (ev.type === 'error') errorMessage = ev.message;
          call.onEvent?.(ev);
        },
      });
      if (errorMessage && !finalText) {
        throw new Error(`ctx.agent (claude) failed: ${errorMessage}`);
      }
      return coerceAgentAnswer(finalText, call.json);
    }

    // codex exec — non-interactive, no approval prompts, runnable
    // outside a git repo. The final assistant message is written to a
    // file so we never have to parse the `--json` event stream.
    const uid = randomUUID().slice(0, 8);
    const lastMessageFile = path.join(scratchDir, `agent-${uid}.out.txt`);
    const args = [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '--ephemeral',
      '--color',
      'never',
      '--cd',
      opts.workdir,
      '--output-last-message',
      lastMessageFile,
    ];
    if (call.json) {
      const schemaFile = path.join(scratchDir, `agent-${uid}.schema.json`);
      await fs.writeFile(schemaFile, JSON.stringify(normalizeOutputSchema(call.json)), 'utf8');
      args.push('--output-schema', schemaFile);
    }
    args.push(call.prompt);

    const result = await collectProcess(spawn('codex', args, spawnOpts));
    if (!result.ok) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new Error(`ctx.agent CLI failed: ${detail.slice(0, 2000)}`);
    }
    let answer: string;
    try {
      answer = await fs.readFile(lastMessageFile, 'utf8');
    } catch {
      // CLI exited 0 but didn't write the message file — fall back to
      // whatever it printed to stdout.
      answer = result.stdout;
    }
    return coerceAgentAnswer(answer, call.json);
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
