/*
 * Reading and folding ACP usage into ONE `usage` event per turn.
 *
 * Schema-verified against the pinned `@agentclientprotocol/sdk` 1.3.0: `UsageUpdate`
 * (the `usage_update` session update) carries only context-window `used`/
 * `size` plus a CUMULATIVE `cost { amount, currency }`; the token breakdown
 * lives on the `session/prompt` RESULT as `PromptResponse.usage`. Both are
 * cumulative per session. The conversation ledger persists the last snapshot
 * beside the resumable session id, so a loaded/warmed session books only its
 * monotonic delta even across gateway process restarts.
 *
 * Everything folds into ONE event at the end of the turn, stamped with
 * the `harness` and only the model identity confirmed by the live ACP session.
 * Requested configuration is not accounting evidence because a harness may
 * ignore it.
 */

import type { Cost, Usage } from "@agentclientprotocol/sdk";

import type {
  HarnessUsageSnapshot,
  HarnessKind,
  TurnStreamEvent,
} from "@centraid/app-engine";

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
  snapshot?: HarnessUsageSnapshot;
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
  previous: HarnessUsageSnapshot | undefined,
  context?: { used?: number; size?: number }
): DeltaCumulativeUsage {
  const tokens: TokenUsage = {};
  const snapshot: HarnessUsageSnapshot = { ...previous };
  const fields = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ] as const;
  for (const field of fields) {
    const current = currentTokens[field];
    if (current === undefined || !Number.isFinite(current) || current < 0)
      continue;
    const prior = previous?.[field];
    tokens[field] =
      prior !== undefined &&
      Number.isFinite(prior) &&
      prior >= 0 &&
      current >= prior
        ? current - prior
        : current;
    (snapshot as Record<(typeof fields)[number], number | undefined>)[field] =
      current;
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
  if (context?.used !== undefined) {
    (snapshot as { contextUsed?: number }).contextUsed = context.used;
  }
  if (context?.size !== undefined) {
    (snapshot as { contextSize?: number }).contextSize = context.size;
  }

  return {
    tokens,
    ...(cost ? { cost } : {}),
    ...(Object.keys(snapshot).length > 0 ? { snapshot } : {}),
  };
}

/**
 * Project the SDK-validated ACP token breakdown into the ledger's normalized
 * token fields.
 */
export function readTokenUsage(source: Usage): TokenUsage {
  return {
    inputTokens: source.inputTokens,
    outputTokens: source.outputTokens,
    ...(source.cachedReadTokens == null
      ? {}
      : { cacheReadTokens: source.cachedReadTokens }),
    ...(source.cachedWriteTokens == null
      ? {}
      : { cacheWriteTokens: source.cachedWriteTokens }),
  };
}

/** ACP `Cost { amount, currency }` — ISO 4217, so anything non-USD isn't `costUsd`. */
export function readCost(raw: Cost | null | undefined): UsageCost | undefined {
  return raw ? { amount: raw.amount, currency: raw.currency } : undefined;
}

/**
 * One usage event per turn, or none when the harness reported nothing worth
 * recording. `model` is stamped whenever we know it: the repricing pipeline
 * can only revisit ledger rows whose model is non-NULL.
 */
export function buildUsageEvent(
  kind: HarnessKind,
  model: string | undefined,
  effort: string | undefined,
  tokens: TokenUsage,
  cost: UsageCost | undefined
): TurnStreamEvent | undefined {
  const costUsd =
    cost && cost.currency.toUpperCase() === "USD" ? cost.amount : undefined;
  // Effort alone is not usage. Emitting for it books a zero-token, zero-cost
  // ledger row whose only content is a configuration label — noise the
  // repricing pipeline then has to carry forever. Effort rides ALONG with
  // real usage (below) when there is any.
  if (Object.keys(tokens).length === 0 && costUsd === undefined) {
    return undefined;
  }
  return {
    type: "usage",
    harness: kind,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...tokens,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}
