/*
 * One `usage` event per turn; ACP totals are CUMULATIVE per session — book
 * monotonic deltas against the persisted snapshot.
 */

import type { Cost, Usage } from "@agentclientprotocol/sdk";

import type {
  HarnessUsageSnapshot,
  HarnessKind,
  TurnStreamEvent,
} from "@centraid/server/engine";

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

/** Regression, currency change, or fresh session = reset charged in full;
 *  missing fields keep their baseline. */
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

/** Token breakdown lives on the prompt RESULT, not `usage_update`. */
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

/** ISO 4217 — anything non-USD isn't `costUsd`. */
export function readCost(raw: Cost | null | undefined): UsageCost | undefined {
  return raw ? { amount: raw.amount, currency: raw.currency } : undefined;
}

/** No real usage → no event. `model` stamped whenever known (repricing
 *  needs non-NULL). */
export function buildUsageEvent(
  kind: HarnessKind,
  model: string | undefined,
  effort: string | undefined,
  tokens: TokenUsage,
  cost: UsageCost | undefined
): TurnStreamEvent | undefined {
  const costUsd =
    cost && cost.currency.toUpperCase() === "USD" ? cost.amount : undefined;
  // Effort alone would book a zero-token, config-only row.
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
