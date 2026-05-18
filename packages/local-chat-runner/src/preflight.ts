/*
 * CLI preflight — runs `--version` once on settings change or gateway
 * boot. The result is cached in-memory and exposed via
 * `GET /centraid/_chat/runner-status` so the panel can show a Setup
 * screen instead of failing per-turn when the binary is missing.
 *
 * We deliberately don't probe `auth-status` here: codex / claude have
 * different auth surfaces (token files, env vars, system keychain) and
 * versioning matters more for adapter compatibility than auth state,
 * which the CLI will surface clearly the first time the user sends a
 * message. A future enhancement can add a non-interactive `claude config
 * list` / `codex auth status` probe; for now, version-only is the
 * minimum-useful signal.
 */

import { spawn } from 'node:child_process';
import type { RunnerStatus } from '@centraid/runtime-core';
import type { RunnerKind, RunnerPrefs } from './types.js';

const VERSION_TIMEOUT_MS = 5_000;

interface CachedStatus {
  status: RunnerStatus;
  /** Inputs the cache was computed against; invalidated when these change. */
  cacheKey: string;
}

let cached: CachedStatus | undefined;

function cacheKey(prefs: RunnerPrefs): string {
  return `${prefs.kind}::${prefs.binPath ?? ''}`;
}

export function invalidatePreflightCache(): void {
  cached = undefined;
}

export async function runPreflight(prefs: RunnerPrefs): Promise<RunnerStatus> {
  const key = cacheKey(prefs);
  if (cached && cached.cacheKey === key) return cached.status;
  const status = await probe(prefs);
  cached = { status, cacheKey: key };
  return status;
}

async function probe(prefs: RunnerPrefs): Promise<RunnerStatus> {
  const bin = prefs.binPath ?? defaultBinFor(prefs.kind);
  try {
    const out = await execVersion(bin);
    return {
      kind: prefs.kind,
      ok: true,
      version: out.trim().slice(0, 200),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        kind: prefs.kind,
        ok: false,
        reason: `${bin} not found on PATH`,
        hint: hintFor(prefs.kind),
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: prefs.kind,
      ok: false,
      reason: message,
      hint: hintFor(prefs.kind),
    };
  }
}

function defaultBinFor(kind: RunnerKind): string {
  return kind === 'codex' ? 'codex' : 'claude';
}

function hintFor(kind: RunnerKind): string {
  if (kind === 'codex') {
    return 'Install Codex CLI (npm i -g @openai/codex-cli or see https://platform.openai.com/docs/codex) and run `codex login`.';
  }
  return 'Install Claude Code (npm i -g @anthropic-ai/claude-code or see https://claude.com/code) and run `claude login`.';
}

async function execVersion(bin: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => {
        child.kill('SIGKILL');
        reject(new Error('--version timed out'));
      });
    }, VERSION_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', (err) => {
      clearTimeout(timer);
      settle(() => reject(err));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) settle(() => resolve(Buffer.concat(chunks).toString('utf8')));
      else settle(() => reject(new Error(`--version exited ${code ?? 'null'}`)));
    });
  });
}
