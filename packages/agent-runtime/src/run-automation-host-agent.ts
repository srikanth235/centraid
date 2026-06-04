/**
 * Default agent backends for the local automation runner.
 *
 * The production `defaultRunHostAgent` lives here (separately from
 * `run-automation-local.ts` which owns the orchestration loop). Tests
 * inject their own backend via the `runHostAgent` option and never hit this
 * file.
 *
 * Both runners are pointed at the per-fire mock-LLM URL + bearer token so
 * tool dispatch round-trips through the mock server, but they reach it
 * differently:
 *   - claude: the Agent SDK's `query()` runs in-process — the same backend
 *     chat and `ctx.agent` already use — with `ANTHROPIC_BASE_URL` /
 *     `ANTHROPIC_API_KEY` pointed at the mock via `options.env`, instead of a
 *     `claude -p` subprocess we manage.
 *   - codex: `codex exec` is spawned as a subprocess. The codex path injects
 *     the mock provider via `codex exec -c` overrides layered on the user's
 *     real `~/.codex` — NOT a redirected `CODEX_HOME` — so the user's
 *     configured `[mcp_servers.*]` stay reachable during deterministic tool
 *     dispatch (issue #158, "ride on top of the user's codex"). `-c` is
 *     honored by `codex exec` since codex-cli 0.128.0, our pinned minimum.
 */

import { spawn } from 'node:child_process';
import { codexProviderOverrideArgs } from './codex-provider-config.js';

export type LocalRunnerKind = 'codex' | 'claude-code';

export interface RunHostAgentInput {
  /** Which agent backend to drive. */
  readonly kind: LocalRunnerKind;
  /**
   * Override the agent binary location; defaults to a PATH lookup of `codex`,
   * or — for claude — the SDK's bundled `claude` executable.
   */
  readonly binPath?: string;
  /** Mock-LLM base URL (`http://127.0.0.1:<port>/v1`). */
  readonly mockBaseUrl: string;
  /** Per-spawn bearer token (`centraid-mock-<dispatchId>`). */
  readonly mockBearerToken: string;
  /** The natural-language prompt to feed the agent. Contains the dispatch sentinel. */
  readonly prompt: string;
  /**
   * Tool allowlist from the manifest. Passed to the Claude SDK's
   * `allowedTools`; ignored for `codex` (which has no `exec` allowlist flag —
   * the mock server enforces the allowlist by only staging permitted calls).
   */
  readonly toolsAllow: readonly string[];
  /** Workspace dir (app code dir) the agent should treat as cwd. */
  readonly cwd: string;
  /** Scratch dir for transient per-spawn files. Auto-cleaned on close. */
  readonly scratchDir: string;
  /** AbortSignal — fires on timeout or external cancel. */
  readonly abortSignal: AbortSignal;
}

export interface RunHostAgentResult {
  /**
   * Subprocess exit code (codex), or null on signal kill / spawn error. The
   * in-process claude SDK path has no process exit code, so it synthesizes
   * `0` on a clean turn and `null` on failure/abort.
   */
  readonly exitCode: number | null;
  /** True on graceful completion (codex `code === 0`, or a clean SDK turn). */
  readonly ok: boolean;
  /** Buffered stderr / failure detail — surfaced in the run record on failure. */
  readonly stderr: string;
}

export type RunHostAgent = (input: RunHostAgentInput) => Promise<RunHostAgentResult>;

export const defaultRunHostAgent: RunHostAgent = async (input) =>
  input.kind === 'claude-code' ? runClaudeAgentSdk(input) : spawnCodexExec(input);

/**
 * Drive one claude turn against the mock with the Agent SDK's in-process
 * `query()` — the same backend chat and `ctx.agent` use — rather than a
 * `claude -p` subprocess. `options.env` points the SDK-spawned claude at the
 * per-fire mock (it replaces the child env wholesale, so the host's
 * `process.env` is never mutated).
 *
 * The mock dictates every turn, so we don't translate the event stream: we
 * just drain the generator to completion. It loops tool_use → tool_result —
 * the SDK executes each staged tool through its native MCP/auth machinery and
 * returns the result through the mock — until the session stages a final
 * `end_turn`, which ends the turn and resolves the generator. `bypassPermissions`
 * preserves the non-interactive behavior of the old spawn: a detached turn
 * must never block on an approval prompt.
 */
async function runClaudeAgentSdk(input: RunHostAgentInput): Promise<RunHostAgentResult> {
  let mod: typeof import('@anthropic-ai/claude-agent-sdk');
  try {
    mod = await import('@anthropic-ai/claude-agent-sdk');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      exitCode: null,
      ok: false,
      stderr: `failed to load @anthropic-ai/claude-agent-sdk: ${msg}`,
    };
  }

  const abort = new AbortController();
  const onAbort = (): void => abort.abort();
  if (input.abortSignal.aborted) abort.abort();
  else input.abortSignal.addEventListener('abort', onAbort, { once: true });

  // Replace the child env wholesale (never mutate process.env): point the
  // SDK-spawned claude at the per-fire mock instead of the real Anthropic API.
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.ANTHROPIC_BASE_URL = input.mockBaseUrl;
  env.ANTHROPIC_API_KEY = input.mockBearerToken;

  const options: Record<string, unknown> = {
    cwd: input.cwd,
    permissionMode: 'bypassPermissions',
    // Required by the SDK alongside permissionMode: 'bypassPermissions'.
    allowDangerouslySkipPermissions: true,
    abortController: abort,
    env,
  };
  // The manifest's `requires.tools` allowlist — the SDK equivalent of the old
  // `claude --allowed-tools` flags.
  if (input.toolsAllow.length > 0) options.allowedTools = [...input.toolsAllow];
  if (input.binPath) options.pathToClaudeCodeExecutable = input.binPath;

  try {
    const generator = mod.query({
      prompt: input.prompt as Parameters<typeof mod.query>[0]['prompt'],
      options: options as Parameters<typeof mod.query>[0]['options'],
    });
    for await (const _ of generator) {
      if (abort.signal.aborted) break;
    }
    // An abort is a timeout / external cancel — surface it as a failure so the
    // awaiting `ctx.tool` batch sees an error rather than a silent success.
    if (input.abortSignal.aborted) {
      return { exitCode: null, ok: false, stderr: 'claude SDK turn aborted' };
    }
    return { exitCode: 0, ok: true, stderr: '' };
  } catch (err) {
    if (input.abortSignal.aborted) {
      return { exitCode: null, ok: false, stderr: 'claude SDK turn aborted' };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { exitCode: null, ok: false, stderr: msg };
  } finally {
    input.abortSignal.removeEventListener('abort', onAbort);
  }
}

/**
 * Spawn `codex exec` as a subprocess pointed at the mock. Routes model calls
 * through the mock provider via `-c` overrides on the user's REAL ~/.codex (no
 * CODEX_HOME redirect), so the user's `[mcp_servers.*]` stay reachable during
 * tool dispatch. The bearer token flows via env under the provider's
 * `env_key`, never on disk.
 */
async function spawnCodexExec(input: RunHostAgentInput): Promise<RunHostAgentResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.CENTRAID_MOCK_KEY = input.mockBearerToken;
  // `codex exec` has no tool-allowlist flag; the mock-LLM server only ever
  // stages tool calls the manifest permits, so the allowlist is already
  // enforced upstream. `--dangerously-bypass-approvals-and-sandbox` lets the
  // staged calls run without an interactive prompt; `--skip-git-repo-check`
  // allows app dirs that aren't git repos.
  const args = [
    'exec',
    ...codexProviderOverrideArgs({
      id: 'centraid-mock',
      name: 'Centraid Automation Mock',
      baseUrl: input.mockBaseUrl,
      // wireApi defaults to 'responses' — the only format codex 0.128+ accepts.
      envKey: 'CENTRAID_MOCK_KEY',
    }),
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    input.prompt,
  ];
  const proc = spawn(input.binPath ?? 'codex', args, {
    cwd: input.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderrChunks: Buffer[] = [];
  proc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  // Drain stdout so the buffer doesn't fill up and block exit. Tool
  // results arrive via the mock server, not the CLI's stdout.
  proc.stdout?.on('data', () => undefined);

  const abortListener = (): void => {
    if (!proc.killed) proc.kill('SIGTERM');
  };
  input.abortSignal.addEventListener('abort', abortListener, { once: true });

  return await new Promise<RunHostAgentResult>((resolve) => {
    proc.on('exit', (code) => {
      input.abortSignal.removeEventListener('abort', abortListener);
      resolve({
        exitCode: code,
        ok: code === 0,
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
    proc.on('error', (err) => {
      input.abortSignal.removeEventListener('abort', abortListener);
      resolve({
        exitCode: null,
        ok: false,
        stderr: `spawn error: ${err.message}\n${Buffer.concat(stderrChunks).toString('utf8')}`,
      });
    });
  });
}
