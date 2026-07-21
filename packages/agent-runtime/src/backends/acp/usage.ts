/*
 * Reading and folding ACP usage into ONE `usage` event per turn.
 *
 * Schema-verified against `@agentclientprotocol/sdk` 1.2.1: `UsageUpdate`
 * (the `usage_update` session update) carries only context-window `used`/
 * `size` plus a CUMULATIVE `cost { amount, currency }`; the token breakdown
 * lives on the `session/prompt` RESULT as `PromptResponse.usage`. Both are
 * cumulative per session — which equals per turn for us, because every turn
 * spawns a fresh agent process whose counters start at zero (a resume replays
 * history but not usage).
 *
 * Everything folds into ONE event at the end of the turn, stamped with
 * `model` + `provider`: the ledger's repricing pipeline can only reprice rows
 * with a non-NULL `items.model`, and downstream consumers keep
 * last-write-wins, so a single stamped event is the difference between a
 * repriceable row and a permanently unpriced one.
 */

import type { RunnerKind, TurnStreamEvent } from '@centraid/app-engine';
import { isObject } from './content.js';

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface UsageCost {
  amount: number;
  currency: string;
}

/**
 * Defensive read of an ACP token breakdown. The spec's `Usage` uses
 * `inputTokens` / `outputTokens` / `cachedReadTokens` / `cachedWriteTokens`;
 * the snake_case and `promptTokens` spellings cover agents that predate it.
 */
export function readTokenUsage(source: Record<string, unknown>): TokenUsage {
  const src = isObject(source.usage) ? source.usage : source;
  const num = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = src[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return undefined;
  };
  const out: TokenUsage = {};
  const input = num('inputTokens', 'input_tokens', 'promptTokens');
  const output = num('outputTokens', 'output_tokens', 'completionTokens');
  const cacheRead = num('cachedReadTokens', 'cacheReadTokens', 'cached_input_tokens');
  const cacheWrite = num('cachedWriteTokens', 'cacheWriteTokens', 'cache_creation_input_tokens');
  if (input !== undefined) out.inputTokens = input;
  if (output !== undefined) out.outputTokens = output;
  if (cacheRead !== undefined) out.cacheReadTokens = cacheRead;
  if (cacheWrite !== undefined) out.cacheWriteTokens = cacheWrite;
  return out;
}

/** ACP `Cost { amount, currency }` — ISO 4217, so anything non-USD isn't `costUsd`. */
export function readCost(raw: unknown): UsageCost | undefined {
  if (!isObject(raw)) return undefined;
  const { amount, currency } = raw;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return undefined;
  if (typeof currency !== 'string') return undefined;
  return { amount, currency };
}

/**
 * One usage event per turn, or none when the agent reported nothing worth
 * recording. `model` is stamped whenever we know it: the repricing pipeline
 * can only revisit ledger rows whose model is non-NULL.
 */
export function buildUsageEvent(
  kind: RunnerKind,
  model: string | undefined,
  tokens: TokenUsage,
  cost: UsageCost | undefined,
): TurnStreamEvent | undefined {
  const costUsd = cost && cost.currency.toUpperCase() === 'USD' ? cost.amount : undefined;
  if (Object.keys(tokens).length === 0 && costUsd === undefined) return undefined;
  return {
    type: 'usage',
    provider: kind,
    ...(model ? { model } : {}),
    ...tokens,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}
