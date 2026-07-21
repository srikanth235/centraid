/**
 * Default agent backends for the local automation runner.
 *
 * The production `defaultRunHostAgent` lives here (separately from
 * `run-automation.ts` which owns the orchestration loop). Tests
 * inject their own backend via the `runHostAgent` option and never hit this
 * file.
 *
 * Only the two kinds whose CLI consumes an HTTP LLM endpoint can host a
 * mock-driven `ctx.tool` batch: claude speaks the Anthropic Messages API and
 * codex the Responses API, so each can be pointed at the per-fire mock-LLM URL
 * + bearer token. `MOCK_HOST_AGENTS` below is the dispatch table; a kind that
 * is not in it fails the batch loudly rather than silently running a different
 * agent than the one the owner pinned (see `unsupportedMockHost`).
 *
 * Both mock-hostable runners reach the mock differently:
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
import type { RunnerKind } from '../types.js';
import { codexProviderOverrideArgs } from '../backends/codex/provider-config.js';
import { agentSpawnEnv } from '../spawn-env.js';
import { lowPriorityCommand } from '../low-priority.js';

export interface RunHostAgentInput {
  /** Which agent backend to drive. */
  readonly kind: RunnerKind;
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

/**
 * Mock-hostable runners, keyed by kind. Kinds absent from this table own
 * their whole model loop behind a stdio JSON-RPC transport (ACP: gemini,
 * qwen, the custom `acp` escape hatch) and expose no LLM base URL to
 * redirect — there is nothing for the per-fire mock to dictate.
 *
 * Before the runner union widened (issue #479) this was a two-arm ternary
 * whose `else` was codex, so any newly registered kind silently ran codex.
 */
const MOCK_HOST_AGENTS: Partial<Record<RunnerKind, RunHostAgent>> = {
  'claude-code': runClaudeAgentSdk,
  codex: spawnCodexExec,
};

export const defaultRunHostAgent: RunHostAgent = async (input) => {
  const host = MOCK_HOST_AGENTS[input.kind];
  return host ? host(input) : unsupportedMockHost(input.kind);
};

/**
 * A `ctx.tool` batch on a runner that can't be pointed at the mock. Reported
 * as an ordinary host-agent failure — `startLiveDispatch`'s `driveAgent` turns
 * it into the awaiting batch's error, so the run record carries an actionable
 * message instead of the fire quietly executing on the wrong agent.
 */
function unsupportedMockHost(kind: RunnerKind): RunHostAgentResult {
  return {
    exitCode: null,
    ok: false,
    stderr:
      `runner "${kind}" cannot host automation ctx.tool batches: tool dispatch ` +
      `works by pointing a CLI at a per-fire mock LLM endpoint, and this runner ` +
      `speaks ACP (it drives its own model loop). Pin runner.automations to ` +
      `codex or claude-code, or use ctx.agent only.`,
  };
}

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
  //
  // Two env-specific traps found live-debugging a hang (this path silently
  // never returned, not even an error):
  //   1. `CLAUDECODE`/`CLAUDE_CODE_SESSION_ID`/`CLAUDE_CODE_ENTRYPOINT`/
  //      `CLAUDE_CODE_EXECPATH`/`CLAUDE_CODE_CHILD_SESSION` — when the host
  //      process inherits these (e.g. the gateway was itself launched from
  //      inside a Claude Code session, as every e2e-live run is), the SDK
  //      treats the spawn as a continuation of that OUTER session and
  //      authenticates with its real (Keychain/OAuth) credentials instead of
  //      `ANTHROPIC_API_KEY` — so the request never reaches the mock at all,
  //      the mock 401s the real bearer, and the SDK retries with growing
  //      backoff instead of failing fast. Stripping every `CLAUDE_CODE_*` /
  //      `CLAUDECODE` var forces a clean, unauthenticated-until-we-say-so spawn.
  //   2. `mockBaseUrl` already carries the mock's own `/v1` suffix (correct
  //      for codex's Responses-API base_url convention) but the SDK's HTTP
  //      client appends its OWN `/v1/messages`, doubling to `/v1/v1/messages`
  //      — which never matches the mock's route table. Strip the trailing
  //      `/v1` before handing it to `ANTHROPIC_BASE_URL`.
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) continue;
    env[k] = v;
  }
  env.ANTHROPIC_BASE_URL = input.mockBaseUrl.replace(/\/v1$/, '');
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
  const env = agentSpawnEnv({
    binPath: input.binPath,
    baseEnv: { ...process.env, CENTRAID_MOCK_KEY: input.mockBearerToken },
  });
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
  const command = lowPriorityCommand(input.binPath ?? 'codex', args);
  const proc = spawn(command.bin, command.args, {
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
