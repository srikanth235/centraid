/*
 * Generic subprocess helper for the CLI adapters.
 *
 * Both adapters spawn their CLI in JSON streaming mode, parse lines off
 * stdout, and translate them into `ChatStreamEvent`s. The mechanics —
 * spawning, line-buffering, abort handling, exit waiting — are identical;
 * only the line→event translation differs per adapter.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export interface SpawnCliOptions {
  bin: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Bytes written to the child's stdin and then closed. Optional. */
  stdin?: string;
  abortSignal: AbortSignal;
  /**
   * Called once per JSON line of stdout. Non-JSON lines are skipped
   * silently (CLIs sometimes prepend a banner or status line).
   */
  onJsonLine: (line: Record<string, unknown>) => void;
  /** Called once per non-empty stderr line. */
  onStderrLine?: (line: string) => void;
}

export interface SpawnCliResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** stderr buffer collected over the run, capped at 64 KiB. */
  stderrTail: string;
}

const STDERR_CAP = 64 * 1024;

/**
 * Spawn `bin args`, stream JSON lines to `onJsonLine`, and resolve when
 * the child exits. The abort signal kills the child with SIGTERM.
 */
export async function spawnCli(opts: SpawnCliOptions): Promise<SpawnCliResult> {
  const child = spawn(opts.bin, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessByStdio<Writable, Readable, Readable>;

  if (opts.stdin !== undefined) {
    child.stdin.end(opts.stdin);
  } else {
    child.stdin.end();
  }

  const abortHandler = (): void => {
    if (!child.killed) child.kill('SIGTERM');
  };
  if (opts.abortSignal.aborted) abortHandler();
  else opts.abortSignal.addEventListener('abort', abortHandler, { once: true });

  let stdoutBuf = '';
  let stderrBuf = '';
  let stderrCapped = false;
  let stderrLineBuf = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuf += chunk;
    let nl = stdoutBuf.indexOf('\n');
    while (nl >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      processLine(line, opts.onJsonLine);
      nl = stdoutBuf.indexOf('\n');
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (!stderrCapped) {
      stderrBuf += chunk;
      if (stderrBuf.length > STDERR_CAP) {
        stderrBuf = stderrBuf.slice(0, STDERR_CAP);
        stderrCapped = true;
      }
    }
    if (opts.onStderrLine) {
      stderrLineBuf += chunk;
      let nl = stderrLineBuf.indexOf('\n');
      while (nl >= 0) {
        const line = stderrLineBuf.slice(0, nl).trim();
        stderrLineBuf = stderrLineBuf.slice(nl + 1);
        if (line) opts.onStderrLine(line);
        nl = stderrLineBuf.indexOf('\n');
      }
    }
  });

  return new Promise<SpawnCliResult>((resolve, reject) => {
    child.on('error', (err) => {
      opts.abortSignal.removeEventListener('abort', abortHandler);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      opts.abortSignal.removeEventListener('abort', abortHandler);
      // Flush any trailing partial line (e.g. final JSON without a newline).
      const tail = stdoutBuf.trim();
      if (tail) processLine(tail, opts.onJsonLine);
      resolve({
        exitCode: code,
        signal,
        stderrTail: stderrBuf.trim(),
      });
    });
  });
}

function processLine(line: string, onJsonLine: (line: Record<string, unknown>) => void): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  // Some CLIs prefix lines with "data: " or "event: " for SSE-like streams;
  // strip the SSE prefix if present.
  const stripped = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
  if (!stripped || !stripped.startsWith('{')) return;
  try {
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    onJsonLine(parsed);
  } catch {
    // ignore — CLIs occasionally print a stray non-JSON line.
  }
}
