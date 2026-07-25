/*
 * Reading and folding ACP usage into ONE `usage` event per turn.
 *
 * Schema-verified against `@agentclientprotocol/sdk` 1.2.1: `UsageUpdate`
 * (the `usage_update` session update) carries only context-window `used`/
 * `size` plus a CUMULATIVE `cost { amount, currency }`; the token breakdown
 * lives on the `session/prompt` RESULT as `PromptResponse.usage`. Both are
 * cumulative per session. The conversation ledger persists the last snapshot
 * beside the resumable session id, so a loaded/warmed session books only its
 * monotonic delta even across gateway process restarts.
 *
 * Everything folds into ONE event at the end of the turn, stamped with
 * `provider` and only the model identity confirmed by the live ACP session.
 * Requested configuration is not accounting evidence because an agent may
 * ignore it.
 */

import type { AdapterUsageSnapshot, RunnerKind, TurnStreamEvent } from '@centraid/app-engine';
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

export interface DeltaCumulativeUsage {
  tokens: TokenUsage;
  cost?: UsageCost;
  snapshot?: AdapterUsageSnapshot;
}

/**
 * Convert ACP's cumulative session totals into the one-turn delta we book.
 *
 * A counter regression, currency change, or fresh session is a reset: the
 * current value is charged in full and becomes the new baseline. Missing
 * fields retain their prior baseline without inventing a zero-valued delta.
 */
export function deltaCumulativeUsage(
  currentTokens: TokenUsage,
  currentCost: UsageCost | undefined,
  previous: AdapterUsageSnapshot | undefined,
): DeltaCumulativeUsage {
  const tokens: TokenUsage = {};
  const snapshot: AdapterUsageSnapshot = { ...previous };
  const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
  for (const field of fields) {
    const current = currentTokens[field];
    if (current === undefined || !Number.isFinite(current) || current < 0) continue;
    const prior = previous?.[field];
    tokens[field] =
      prior !== undefined && Number.isFinite(prior) && prior >= 0 && current >= prior
        ? current - prior
        : current;
    (snapshot as Record<(typeof fields)[number], number | undefined>)[field] = current;
  }

  let cost: UsageCost | undefined;
  if (currentCost && currentCost.amount >= 0) {
    const prior = previous?.cost;
    cost = {
      amount:
        prior &&
        prior.currency.toUpperCase() === currentCost.currency.toUpperCase() &&
        currentCost.amount >= prior.amount
          ? currentCost.amount - prior.amount
          : currentCost.amount,
      currency: currentCost.currency,
    };
    (snapshot as { cost?: UsageCost }).cost = currentCost;
  }

  return {
    tokens,
    ...(cost ? { cost } : {}),
    ...(Object.keys(snapshot).length > 0 ? { snapshot } : {}),
  };
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
