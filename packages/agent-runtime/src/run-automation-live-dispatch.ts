/*
 * Live `ctx.tool` / `ctx.agent` dispatch for the local automation
 * runner.
 *
 * Split out of `run-automation-local.ts` so that file can stay focused
 * on the per-fire lifecycle (manifest load, audit store, onFailure
 * cascade). This module owns the "live" side: the persistent mock-LLM
 * session, the single long-lived agent turn that executes every
 * `ctx.tool` batch (an in-process Claude SDK `query()` for claude, a
 * `codex exec` subprocess for codex), and the `ctx.agent` one-shot
 * against the user's real provider.
 *
 * Issue #166 — persistent session: a fire opens ONE agent session pointed
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
import {
  coerceAgentAnswer,
  startPersistentMockSession,
  type AgentDriver,
  type AutomationAgentDispatcher,
  type AutomationToolDispatcher,
} from '@centraid/conversation-engine';
import { runClaudeSdkTurn } from './claude-sdk.js';
import {
  defaultRunHostAgent,
  type LocalRunnerKind,
  type RunHostAgent,
} from './run-automation-host-agent.js';

export interface LiveDispatchOptions {
  /** The automation app directory — also the CLI's cwd. */
  workdir: string;
  /** Id of the automation being fired. */
  automationId: string;
  runId: string;
  runner: LocalRunnerKind;
  runHostAgent: RunHostAgent;
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
 * Stand up the live dispatch surface for the CLI runner: the shared persistent
 * mock session (issue #166) plus a scratch dir. The agent session is started
 * lazily on the first `ctx.tool` batch (an automation that never calls a tool
 * never opens one). The only runner-specific piece is the `driveAgent` adapter,
 * which runs the Claude SDK `query()` / `codex exec` against the mock;
 * everything else (the mock, batch staging/correlation, timing) is shared.
 */
export async function startLiveDispatch(opts: LiveDispatchOptions): Promise<LiveDispatch> {
  const scratchDir = path.join(opts.workdir, '.automation-scratch', opts.runId);
  await fs.mkdir(scratchDir, { recursive: true });

  // The host agent adapter: point an in-process Claude SDK `query()` / a
  // `codex exec` subprocess at the mock for the lifetime of the fire. Resolves
  // when the agent turn ends (`close()` stages the final `end_turn`).
  const driveAgent: AgentDriver = async (input) => {
    const outcome = await opts.runHostAgent({
      kind: opts.runner,
      mockBaseUrl: input.mockBaseUrl,
      mockBearerToken: input.mockBearerToken,
      prompt: input.prompt,
      toolsAllow: opts.toolsAllow,
      cwd: input.cwd,
      scratchDir,
      abortSignal: input.abortSignal,
    });
    return outcome.ok
      ? { ok: true }
      : {
          ok: false,
          error: `CLI exited code=${outcome.exitCode ?? '?'}\n${outcome.stderr.slice(0, 2000)}`,
        };
  };

  const session = await startPersistentMockSession({
    workdir: opts.workdir,
    automationId: opts.automationId,
    driveAgent,
    onLog: opts.onLog,
  });
  const toolDispatcher: AutomationToolDispatcher = session.toolDispatcher;

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
      // `claude -p` spawn. The turn now streams token-level TurnStreamEvents
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
      // End the shared session (final `end_turn` + drain + mock stop), then
      // remove the CLI scratch dir this host owns.
      await session.close().catch(() => undefined);
      await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export { defaultRunHostAgent };
