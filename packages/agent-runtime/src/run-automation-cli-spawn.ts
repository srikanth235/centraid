/**
 * Default CLI-spawn implementation for the local automation runner.
 *
 * The production `defaultSpawnCli` lives here (separately from
 * `run-automation-local.ts` which owns the orchestration loop). Tests
 * inject their own spawn via the `spawnCli` option and never hit this
 * file.
 *
 * Both runners (`claude -p` for Claude, `codex exec` for codex) are
 * pointed at the per-fire mock-LLM URL + bearer token so tool dispatch
 * round-trips through the mock server. The codex path materializes a
 * transient `CODEX_HOME` so the per-invocation provider override lands
 * even if `codex exec -c` doesn't accept it on the installed version.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { materializeCodexHome } from './codex-provider-config.js';

export type LocalRunnerKind = 'codex' | 'claude-code';

export interface SpawnCliInput {
  /** Which CLI to invoke. */
  readonly kind: LocalRunnerKind;
  /** Mock-LLM base URL (`http://127.0.0.1:<port>/v1`). */
  readonly mockBaseUrl: string;
  /** Per-spawn bearer token (`centraid-mock-<dispatchId>`). */
  readonly mockBearerToken: string;
  /** The natural-language prompt to feed the CLI. Contains the dispatch sentinel. */
  readonly prompt: string;
  /** Tool allowlist from the manifest — passed to the CLI's MCP tool restriction flag. */
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
    const args = [
      '-p',
      input.prompt,
      '--output-format',
      'stream-json',
      '--permission-mode',
      'bypassPermissions',
    ];
    for (const tool of input.toolsAllow) args.push('--allowed-tools', tool);
    proc = spawn('claude', args, { cwd: input.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    const codexHome = await materializeCodexHome(
      {
        id: 'centraid-mock',
        name: 'Centraid Automation Mock',
        baseUrl: input.mockBaseUrl,
        wireApi: 'chat',
        envKey: 'CENTRAID_MOCK_KEY',
      },
      input.scratchDir,
    );
    env.CODEX_HOME = codexHome;
    env.CENTRAID_MOCK_KEY = input.mockBearerToken;
    const args = ['exec', '--json', '--ask-for-approval', 'never'];
    for (const tool of input.toolsAllow) args.push('--allowed-tools', tool);
    args.push(input.prompt);
    proc = spawn('codex', args, { cwd: input.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
