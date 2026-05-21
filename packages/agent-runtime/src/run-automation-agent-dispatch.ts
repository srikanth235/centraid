/**
 * Local `AutomationAgentDispatcher` (issue #90 model-B).
 *
 * Runs one automation agent turn by spawning the codex / claude CLI with
 * the manifest prompt, then yields the trace events
 * `runAutomationAgent` records into the ledger. The CLI streams a
 * JSON trace on stdout; this module does a best-effort parse for the
 * per-turn token usage so the run's `step` node carries real token
 * counts (and, via the price table, a frozen `cost_usd`).
 *
 * Per-tool-call event extraction is intentionally minimal here — the
 * turn is recorded as a single `step`. Richer trace parsing is wired in
 * the Insights commit alongside the chat runner's usage capture.
 */

import type {
  AutomationAgentDispatcher,
  AutomationAgentEvent,
  TokenUsage,
} from '@centraid/runtime-core';
import {
  defaultSpawnCli,
  type LocalRunnerKind,
  type SpawnCli,
} from './run-automation-cli-spawn.js';

export interface LocalAgentDispatchOptions {
  /** Which CLI to drive. */
  readonly runner: LocalRunnerKind;
  /** Workspace dir the CLI runs in. */
  readonly cwd: string;
  /** Override the CLI binary path. */
  readonly binPath?: string;
  /** Override spawn for tests. */
  readonly spawnCli?: SpawnCli;
  /** Optional logger. */
  readonly onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/**
 * Scan a CLI stream-json transcript for the turn's token usage. Both
 * runners emit one JSON object per line; we look for the last object
 * carrying a recognizable `usage` shape (codex `token_count`, claude
 * `result`). Best-effort — an unparseable transcript yields `{}`.
 */
function parseUsage(stdout: string): TokenUsage {
  let usage: TokenUsage = {};
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const raw = (obj.usage ?? (obj.msg as Record<string, unknown> | undefined)?.usage) as
      | Record<string, unknown>
      | undefined;
    if (!raw || typeof raw !== 'object') continue;
    const num = (...keys: string[]): number | undefined => {
      for (const k of keys) {
        const v = raw[k];
        if (typeof v === 'number') return v;
      }
      return undefined;
    };
    const next: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    } = {};
    const input = num('input_tokens', 'inputTokens', 'prompt_tokens');
    const output = num('output_tokens', 'outputTokens', 'completion_tokens');
    const cacheRead = num('cache_read_input_tokens', 'cacheReadInputTokens', 'cached_input_tokens');
    const cacheWrite = num('cache_creation_input_tokens', 'cacheCreationInputTokens');
    if (input !== undefined) next.inputTokens = input;
    if (output !== undefined) next.outputTokens = output;
    if (cacheRead !== undefined) next.cacheReadTokens = cacheRead;
    if (cacheWrite !== undefined) next.cacheWriteTokens = cacheWrite;
    if (Object.keys(next).length > 0) usage = next;
  }
  return usage;
}

/**
 * Build a dispatcher that runs the turn through the local codex /
 * claude CLI.
 */
export function makeLocalAgentDispatcher(
  opts: LocalAgentDispatchOptions,
): AutomationAgentDispatcher {
  const spawnCli = opts.spawnCli ?? defaultSpawnCli;
  return async function* dispatch(input): AsyncGenerator<AutomationAgentEvent> {
    const startedAt = Date.now();
    const result = await spawnCli({
      kind: opts.runner,
      ...(opts.binPath ? { binPath: opts.binPath } : {}),
      prompt: input.prompt,
      toolsAllow: input.requires.tools ?? [],
      cwd: opts.cwd,
      abortSignal: input.abortSignal,
    });
    const endedAt = Date.now();

    const usage = parseUsage(result.stdout);
    const step: AutomationAgentEvent = {
      type: 'step',
      ...(input.requires.model ? { model: input.requires.model } : {}),
      ...(opts.runner === 'codex' ? { provider: 'codex' } : { provider: 'anthropic' }),
      usage,
      startedAt,
      endedAt,
    };
    yield step;

    if (!result.ok) {
      const detail = result.stderr.trim() || `agent CLI exited with code ${result.exitCode}`;
      opts.onLog?.('error', `automation agent turn failed: ${detail}`);
      throw new Error(detail);
    }

    yield { type: 'output', summary: 'automation agent turn completed' };
  };
}
