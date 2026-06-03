/*
 * Per-runner model enumeration by self-report.
 *
 * Each CLI-backed runner knows the concrete model ids it can actually run,
 * so we ask the runner itself rather than hardcoding a catalog or fetching
 * an external one:
 *
 *  - claude-code: `claude -p "<prompt>"` — the Claude Code harness injects
 *    the live model list into context, so the model reports its current
 *    pinned ids (verified reproducible), including builds newer than its
 *    training cutoff. We strip code fences and validate `claude-*` shape.
 *  - codex: the app-server `model/list` JSON-RPC method (see
 *    codex-model-list.ts).
 *
 * Everything is best-effort: any failure (binary missing, timeout, garbage
 * output) resolves to `[]` so the caller falls back to the default seed.
 * Enumeration is only ever invoked on an explicit Refresh, never on a normal
 * runner-status read.
 */

import { spawn } from 'node:child_process';
import type { RunnerKind, RunnerModel } from '@centraid/app-engine';
import { enumerateCodexModels } from './codex-model-list.js';

/** An inference turn — allow a generous cap; Refresh-only so latency is fine. */
const CLAUDE_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const CLAUDE_ENUMERATION_PROMPT =
  'List every Claude model id you have access to. ' +
  'Output ONLY a JSON array of the exact model id strings (the values you would ' +
  'pass to --model), nothing else. Example format: ["<id>","<id>"].';

/** Looks like a Claude model id (e.g. `claude-opus-4-8`, `claude-haiku-4-5-20251001`). */
const CLAUDE_ID_RE = /^claude-[a-z0-9.-]+$/i;

/**
 * Enumerate the concrete models the active runner can serve. Returns `[]`
 * on any failure — never throws.
 */
export function enumerateRunnerModels(prefs: {
  kind: RunnerKind;
  binPath?: string;
  extraArgs?: string[];
}): Promise<RunnerModel[]> {
  switch (prefs.kind) {
    case 'claude-code':
      // The claude SDK turn path ignores extraArgs, so enumeration does too.
      return enumerateClaudeModels(prefs.binPath);
    case 'codex':
      // Mirror the runner's `codex app-server` args so we enumerate the same
      // catalog the real runner serves (e.g. a `-c`/profile override).
      return enumerateCodexModels(prefs.binPath, prefs.extraArgs);
    default:
      return Promise.resolve([]);
  }
}

/** Run `claude -p` and parse the JSON array of model ids it reports. */
export function enumerateClaudeModels(binPath = 'claude'): Promise<RunnerModel[]> {
  return new Promise<RunnerModel[]>((resolve) => {
    let child;
    try {
      child = spawn(binPath, ['-p', CLAUDE_ENUMERATION_PROMPT], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve([]);
      return;
    }

    let out = '';
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (!child.killed) child.kill('SIGTERM');
      fn();
    };

    const timer = setTimeout(() => settle(() => resolve([])), CLAUDE_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      out += c;
      if (out.length > MAX_OUTPUT_BYTES) {
        clearTimeout(timer);
        settle(() => resolve(parseClaudeModelList(out)));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => {
      /* drain */
    });
    child.on('error', () => {
      clearTimeout(timer);
      settle(() => resolve([]));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      settle(() => resolve(code === 0 ? parseClaudeModelList(out) : []));
    });
  });
}

/**
 * Parse `claude -p` output into RunnerModel[]. Strips ``` / ```json fences,
 * extracts the first JSON array, and keeps only entries that look like
 * Claude model ids. Returns `[]` on any failure.
 */
export function parseClaudeModelList(stdout: string): RunnerModel[] {
  let text = stdout.trim();
  // Strip a leading/trailing code fence if the model wrapped the array.
  text = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  // Fall back to slicing the first [...] block out of any surrounding prose.
  if (!text.startsWith('[')) {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start < 0 || end <= start) return [];
    text = text.slice(start, end + 1);
  }
  let arr: unknown;
  try {
    arr = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const seen = new Set<string>();
  const models: RunnerModel[] = [];
  for (const raw of arr) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id || !CLAUDE_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    models.push({ id });
  }
  return models;
}
