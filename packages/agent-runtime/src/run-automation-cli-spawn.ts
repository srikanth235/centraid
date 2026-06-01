/**
 * Default CLI-spawn implementation for the local automation runner.
 *
 * The production `defaultSpawnCli` lives here (separately from
 * `run-automation-local.ts` which owns the orchestration loop). Tests
 * inject their own spawn via the `spawnCli` option and never hit this
 * file.
 *
 * All three runners (`claude -p` for Claude, `codex exec` for codex,
 * `openclaw agent --local` for OpenClaw) are pointed at the per-fire
 * mock-LLM URL + bearer token so `ctx.tool` dispatch round-trips through
 * the mock server. The codex path materializes a transient `CODEX_HOME`
 * so the per-invocation provider override lands even if `codex exec -c`
 * doesn't accept it on the installed version; the openclaw path uses the
 * `OPENAI_BASE_URL` / `OPENAI_API_KEY` env override openclaw honors for
 * OpenAI-compatible providers.
 *
 * NOTE (openclaw): the `ctx.tool` round-trip through the mock for the
 * openclaw runner is wired the same way as codex/claude but has not yet
 * been exercised against a live `openclaw` build — validate the staged-
 * tool round-trip end-to-end before relying on openclaw automations that
 * call `ctx.tool`. The `ctx.agent` one-shot (real provider, no mock) is
 * the primary openclaw automation path (see `run-automation-live-dispatch.ts`).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { materializeCodexHome } from './codex-provider-config.js';

export type LocalRunnerKind = 'codex' | 'claude-code' | 'openclaw';

export interface SpawnCliInput {
  /** Which CLI to invoke. */
  readonly kind: LocalRunnerKind;
  /** Override the CLI binary location; defaults to a PATH lookup of `codex`/`claude`. */
  readonly binPath?: string;
  /** Mock-LLM base URL (`http://127.0.0.1:<port>/v1`). */
  readonly mockBaseUrl: string;
  /** Per-spawn bearer token (`centraid-mock-<dispatchId>`). */
  readonly mockBearerToken: string;
  /** The natural-language prompt to feed the CLI. Contains the dispatch sentinel. */
  readonly prompt: string;
  /**
   * Tool allowlist from the manifest. Passed to `claude --allowed-tools`;
   * ignored for `codex` (which has no `exec` allowlist flag — the mock
   * server enforces the allowlist by only staging permitted calls).
   */
  readonly toolsAllow: readonly string[];
  /** Workspace dir (app code dir) the CLI should treat as cwd. */
  readonly cwd: string;
  /** Scratch dir for transient files (CODEX_HOME, etc). Auto-cleaned on close. */
  readonly scratchDir: string;
  /** AbortSignal — fires on timeout or external cancel. */
  readonly abortSignal: AbortSignal;
}

export interface SpawnCliResult {
  /** Process exit code, or null when killed by signal. */
  readonly exitCode: number | null;
  /** True on graceful exit (code === 0). */
  readonly ok: boolean;
  /** Buffered stderr — surfaced in the run record on failure. */
  readonly stderr: string;
}

export type SpawnCli = (input: SpawnCliInput) => Promise<SpawnCliResult>;

export const defaultSpawnCli: SpawnCli = async (input) => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  let proc: ChildProcess;
  if (input.kind === 'claude-code') {
    env.ANTHROPIC_BASE_URL = input.mockBaseUrl;
    env.ANTHROPIC_API_KEY = input.mockBearerToken;
    // `claude --print --output-format=stream-json` requires `--verbose`
    // on current claude (2.1.x); without it the CLI exits non-zero
    // before making a single model request.
    const args = [
      '-p',
      input.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
    ];
    for (const tool of input.toolsAllow) args.push('--allowed-tools', tool);
    proc = spawn(input.binPath ?? 'claude', args, {
      cwd: input.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else if (input.kind === 'openclaw') {
    // openclaw honors the OpenAI-compatible env override, so the per-fire
    // mock-LLM endpoint takes over for the duration of the spawn — the
    // user's shell-configured provider is shadowed only here, only for the
    // tool round-trip. `agent --local` keys its workspace off process.cwd
    // (no `--cwd` flag on the `agent` command), so the spawn `cwd` is the
    // app dir. There's no tool-allowlist flag (the mock only ever stages
    // permitted calls, so the allowlist is enforced upstream as with codex).
    env.OPENAI_BASE_URL = input.mockBaseUrl;
    env.OPENAI_API_KEY = input.mockBearerToken;
    const args = ['agent', '--local', '--json', '--message', input.prompt];
    proc = spawn(input.binPath ?? 'openclaw', args, {
      cwd: input.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    const codexHome = await materializeCodexHome(
      {
        id: 'centraid-mock',
        name: 'Centraid Automation Mock',
        baseUrl: input.mockBaseUrl,
        // wireApi defaults to 'responses' — the only format codex 0.128+ accepts.
        envKey: 'CENTRAID_MOCK_KEY',
      },
      input.scratchDir,
    );
    env.CODEX_HOME = codexHome;
    env.CENTRAID_MOCK_KEY = input.mockBearerToken;
    // `codex exec` has no tool-allowlist flag; the mock-LLM server only
    // ever stages tool calls the manifest permits, so the allowlist is
    // already enforced upstream. `--dangerously-bypass-approvals-and-sandbox`
    // lets the staged calls run without an interactive prompt;
    // `--skip-git-repo-check` allows app dirs that aren't git repos.
    const args = [
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      input.prompt,
    ];
    proc = spawn(input.binPath ?? 'codex', args, {
      cwd: input.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  const stderrChunks: Buffer[] = [];
  proc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  // Drain stdout so the buffer doesn't fill up and block exit. Tool
  // results arrive via the mock server, not the CLI's stdout.
  proc.stdout?.on('data', () => undefined);

  const abortListener = (): void => {
    if (!proc.killed) proc.kill('SIGTERM');
  };
  input.abortSignal.addEventListener('abort', abortListener, { once: true });

  return await new Promise<SpawnCliResult>((resolve) => {
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
};
