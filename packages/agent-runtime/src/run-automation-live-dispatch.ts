/*
 * Live `ctx.tool` / `ctx.agent` dispatch for the local automation
 * runner.
 *
 * Split out of `run-automation-local.ts` so that file can stay focused
 * on the per-fire lifecycle (manifest load, audit store, onFailure
 * cascade). This module owns the "live" side: the persistent mock-LLM
 * session, the single long-lived CLI subprocess that executes every
 * `ctx.tool` batch, and the `ctx.agent` one-shot against the user's
 * real provider.
 *
 * Issue #166 — persistent session: a fire spawns ONE CLI session pointed
 * at the mock and keeps it alive across the whole handler run. The
 * deterministic handler drives; each `ctx.tool` batch is staged into the
 * live session (the CLI executes the tools natively through its MCP/auth
 * machinery and returns `tool_result` blocks), and the session only exits
 * when the fire ends and the driver stages a final `end_turn`. This
 * replaces the previous per-batch cold-start spawn: one session, ~0 real
 * model tokens (the mock dictates every turn), a structurally single and
 * controlled session. `ctx.agent` is the only billed path — a separate
 * bounded turn against the user's real provider.
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
} from '@centraid/automation-engine';
import { startMockLlmServer, type StagedTurn } from './mock-llm-server.js';
import { runClaudeSdkTurn } from './claude-sdk.js';
import {
  defaultSpawnCli,
  type LocalRunnerKind,
  type SpawnCli,
  type SpawnCliResult,
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

/**
 * Compose the persistent CLI session prompt. The mock dictates every turn,
 * so the content barely matters — but a clear instruction keeps the CLI in
 * "execute the staged tool, return its result, await the next" mode for the
 * lifetime of the session (issue #166).
 */
function buildSessionPrompt(automationId: string): string {
  return (
    `<<<centraid:${automationId}>>>\n` +
    'You are the deterministic tool executor for a centraid automation. ' +
    'Execute each staged tool call exactly as given and return its tool_result. ' +
    'Do not improvise, add tools, or stop early — continue until told the run is complete.'
  );
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

/** One captured tool result as the mock surfaces it. */
type CapturedResult = { id: string; content: string; isError: boolean };

/** What a parked `toolDispatcher` is woken with: results, or a dead session. */
type BatchOutcome =
  | { kind: 'results'; results: ReadonlyArray<CapturedResult> }
  | { kind: 'exit'; outcome: SpawnCliResult };

const closeKindError = (outcome: SpawnCliResult): string =>
  `CLI session exited code=${outcome.exitCode ?? '?'} before returning tool results\n${outcome.stderr.slice(0, 2000)}`;

/**
 * Race `promise` against an `ms` deadline. Bounds teardown so a wedged CLI
 * never hangs the fire, and clears the timer the moment the promise wins so
 * a finished run leaves no dangling timeout holding the event loop open.
 */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    let settled = false;
    const settle = (v: T | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const timer = setTimeout(() => settle(undefined), ms);
    void promise.then(
      (v) => {
        clearTimeout(timer);
        settle(v);
      },
      () => {
        clearTimeout(timer);
        settle(undefined);
      },
    );
  });
}

/**
 * Stand up the live dispatch surface: a persistent mock-LLM server plus a
 * scratch dir. The CLI session itself is spawned lazily on the first
 * `ctx.tool` batch (an automation that never calls a tool never spawns one).
 * Returns the two dispatchers and a `close()` that ends the session and tears
 * everything down.
 */
export async function startLiveDispatch(opts: LiveDispatchOptions): Promise<LiveDispatch> {
  const scratchDir = path.join(opts.workdir, '.automation-scratch', opts.runId);
  await fs.mkdir(scratchDir, { recursive: true });

  interface BatchAwaiter {
    settle(outcome: BatchOutcome): void;
  }
  // Single persistent dispatch → at most one outstanding batch awaiter at a
  // time (the handler awaits each `ctx.tool` before the next). Keyed by the
  // session dispatch id so the mock callbacks can find the current awaiter.
  const batchAwaiters = new Map<string, BatchAwaiter>();

  // Per-call timing (issue #158, Phase 3): the mock signals when it hands the
  // CLI a tool (start) and when each result lands (finish). Tool-use ids are
  // globally unique (randomUUID), so a flat id→window map serves the whole
  // persistent session — each tool node records its real execution window
  // rather than a batch span that also covers CLI spawn/teardown.
  const toolTiming = new Map<string, { startedAt?: number; endedAt?: number }>();
  const timingFor = (id: string): { startedAt?: number; endedAt?: number } => {
    let entry = toolTiming.get(id);
    if (!entry) {
      entry = {};
      toolTiming.set(id, entry);
    }
    return entry;
  };

  const mock = await startMockLlmServer({
    onLog: opts.onLog,
    onToolStart: (_dispatchId, toolUses) => {
      const now = Date.now();
      for (const u of toolUses) timingFor(u.id).startedAt = now;
    },
    onToolResults: (dispatchId, results) => {
      const now = Date.now();
      for (const r of results) timingFor(r.id).endedAt = now;
      const pending = batchAwaiters.get(dispatchId);
      if (pending) pending.settle({ kind: 'results', results });
    },
  });

  // The persistent session: minted + spawned lazily, shared by every batch.
  interface Session {
    dispatchId: string;
    spawn: Promise<SpawnCliResult>;
    exited: SpawnCliResult | undefined;
  }
  let session: Session | undefined;

  const ensureSession = (ctx: AutomationDispatchContext): Session => {
    if (session) return session;
    const { dispatchId, bearerToken } = mock.mintDispatchToken();
    const spawn = opts.spawnCli({
      kind: opts.runner,
      mockBaseUrl: mock.baseUrl,
      mockBearerToken: bearerToken,
      prompt: buildSessionPrompt(ctx.automationId),
      toolsAllow: opts.toolsAllow,
      cwd: opts.workdir,
      scratchDir,
      abortSignal: ctx.abortSignal,
    });
    const s: Session = { dispatchId, spawn, exited: undefined };
    // If the CLI session dies (crash / abort) while a batch is parked, wake
    // the awaiter so the handler sees a failure instead of hanging forever.
    void spawn.then((outcome) => {
      s.exited = outcome;
      const pending = batchAwaiters.get(dispatchId);
      if (pending) pending.settle({ kind: 'exit', outcome });
    });
    session = s;
    return s;
  };

  const toolDispatcher: AutomationToolDispatcher = async (
    calls: readonly AutomationToolCall[],
    ctx: AutomationDispatchContext,
  ): Promise<AutomationToolResult[]> => {
    const s = ensureSession(ctx);
    if (s.exited) {
      // Session already gone (a prior batch killed it) — fail fast.
      return calls.map(() => ({ ok: false, error: closeKindError(s.exited!) }));
    }
    const turn = batchToStagedTurn(calls);

    // Register the awaiter BEFORE staging: staging releases the parked CLI
    // request, which may deliver results almost immediately.
    const outcomePromise = new Promise<BatchOutcome>((resolve) => {
      batchAwaiters.set(s.dispatchId, {
        settle(outcome) {
          batchAwaiters.delete(s.dispatchId);
          resolve(outcome);
        },
      });
    });
    mock.stageTurn(s.dispatchId, turn);

    const outcome = await outcomePromise;
    if (outcome.kind === 'exit') {
      return calls.map(() => ({ ok: false, error: closeKindError(outcome.outcome) }));
    }

    const turnUses = turn.toolUses ?? [];
    const byIdx = new Map<number, { content: string; isError: boolean }>();
    for (const r of outcome.results) {
      const useIdx = turnUses.findIndex((u) => u.id === r.id);
      if (useIdx >= 0) byIdx.set(useIdx, { content: r.content, isError: r.isError });
    }
    const timing = (idx: number): { startedAt?: number; endedAt?: number } => {
      const t = toolTiming.get(turnUses[idx]?.id ?? '');
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
      // End the persistent session: stage a final `end_turn` so the CLI
      // session completes and exits, then wait (bounded) for it to drain.
      // `mock.close()` releases any straggler parked request afterwards.
      if (session && !session.exited) {
        try {
          mock.stageTurn(session.dispatchId, { text: '', stopReason: 'end_turn' });
        } catch {
          /* a turn may already be buffered; mock.close() will release it */
        }
        await withDeadline(session.spawn, 5000);
      }
      await mock.close().catch(() => undefined);
      await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export { defaultSpawnCli };
