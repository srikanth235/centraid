/**
 * CLI-spawn implementation for the local agent-driven automation runner
 * (issue #90 model-B).
 *
 * An automation fire is now an agent turn: the manifest prompt is handed
 * straight to `codex exec` / `claude -p`, which run the agentic loop
 * against the user's own provider auth (no mock-LLM server, no JS
 * handler). The spawn returns once the turn finishes.
 *
 * Tests inject their own spawn via the `spawnCli` option and never hit
 * this file.
 */

import { spawn, type ChildProcess } from 'node:child_process';

export type LocalRunnerKind = 'codex' | 'claude-code';

export interface SpawnCliInput {
  /** Which CLI to invoke. */
  readonly kind: LocalRunnerKind;
  /** Override the CLI binary location; defaults to a PATH lookup of `codex`/`claude`. */
  readonly binPath?: string;
  /** The manifest prompt — the instruction handed to the agent. */
  readonly prompt: string;
  /** Tool allowlist from the manifest. Passed to `claude --allowed-tools`. */
  readonly toolsAllow: readonly string[];
  /** Workspace dir the CLI should treat as cwd. */
  readonly cwd: string;
  /** AbortSignal — fires on timeout or external cancel. */
  readonly abortSignal: AbortSignal;
}

export interface SpawnCliResult {
  /** Process exit code, or null when killed by signal. */
  readonly exitCode: number | null;
  /** True on graceful exit (code === 0). */
  readonly ok: boolean;
  /** Buffered stdout — the agent's stream-json trace. */
  readonly stdout: string;
  /** Buffered stderr — surfaced in the run record on failure. */
  readonly stderr: string;
}

export type SpawnCli = (input: SpawnCliInput) => Promise<SpawnCliResult>;

export const defaultSpawnCli: SpawnCli = async (input) => {
  let proc: ChildProcess;
  if (input.kind === 'claude-code') {
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
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    // `codex exec` has no tool-allowlist flag.
    // `--dangerously-bypass-approvals-and-sandbox` lets staged calls run
    // without an interactive prompt; `--skip-git-repo-check` allows app
    // dirs that aren't git repos.
    const args = [
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      input.prompt,
    ];
    proc = spawn(input.binPath ?? 'codex', args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  proc.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  proc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

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
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
    proc.on('error', (err) => {
      input.abortSignal.removeEventListener('abort', abortListener);
      resolve({
        exitCode: null,
        ok: false,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: `spawn error: ${err.message}\n${Buffer.concat(stderrChunks).toString('utf8')}`,
      });
    });
  });
};
