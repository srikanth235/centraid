/**
 * Direct unit tests for ACP usage folding (issue #545 B11).
 */

import { describe, expect, it } from 'vitest';
import { buildUsageEvent, readCost, readTokenUsage } from './usage.ts';

describe('readTokenUsage', () => {
  it('reads camelCase, snake_case, and nested usage bags', () => {
    expect(
      readTokenUsage({
        inputTokens: 1,
        outputTokens: 2,
        cachedReadTokens: 3,
        cachedWriteTokens: 4,
      }),
    ).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    });
    expect(
      readTokenUsage({
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cacheReadTokens: 5,
          cache_creation_input_tokens: 6,
        },
      }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 6,
    });
    expect(readTokenUsage({ promptTokens: 7, completionTokens: 8 })).toEqual({
      inputTokens: 7,
      outputTokens: 8,
    });
    expect(readTokenUsage({})).toEqual({});
    expect(readTokenUsage({ inputTokens: Number.NaN })).toEqual({});
  });
});

describe('readCost / buildUsageEvent', () => {
  it('readCost requires finite amount + string currency', () => {
    expect(readCost(null)).toBeUndefined();
    expect(readCost({ amount: 1 })).toBeUndefined();
    expect(readCost({ amount: Number.NaN, currency: 'USD' })).toBeUndefined();
    expect(readCost({ amount: 1.25, currency: 'USD' })).toEqual({
      amount: 1.25,
      currency: 'USD',
    });
  });

  it('buildUsageEvent stamps model/provider and only USD cost', () => {
    expect(buildUsageEvent('codex', undefined, {}, undefined)).toBeUndefined();
    expect(
      buildUsageEvent('claude-code', 'm1', { inputTokens: 1 }, { amount: 2, currency: 'EUR' }),
    ).toEqual({
      type: 'usage',
      provider: 'claude-code',
      model: 'm1',
      inputTokens: 1,
    });
    expect(
      buildUsageEvent('codex', 'm2', { outputTokens: 3 }, { amount: 0.5, currency: 'usd' }),
    ).toEqual({
      type: 'usage',
      provider: 'codex',
      model: 'm2',
      outputTokens: 3,
      costUsd: 0.5,
    });
    // Cost-only (no tokens) still emits when USD.
    expect(buildUsageEvent('codex', undefined, {}, { amount: 1, currency: 'USD' })).toEqual({
      type: 'usage',
      provider: 'codex',
      costUsd: 1,
    });
  });
});
