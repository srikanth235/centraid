// `deltaCumulativeUsage` is where a turn's money is decided: ACP reports
// CUMULATIVE session totals, so every branch here is either "book the right
// delta" or "lose/duplicate spend". The end-to-end stamping lives in
// backend.model-usage.test.ts; this file pins the arithmetic itself.

import { describe, expect, it } from 'vitest';
import { buildUsageEvent, deltaCumulativeUsage, readCost, readTokenUsage } from './usage.js';

describe('deltaCumulativeUsage', () => {
  it('books the full total when there is no prior snapshot', () => {
    const d = deltaCumulativeUsage({ inputTokens: 100, outputTokens: 50 }, undefined, undefined);
    expect(d.tokens).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(d.snapshot).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('books cumulative-minus-baseline on a resumed session', () => {
    const d = deltaCumulativeUsage(
      { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 5 },
      undefined,
      { inputTokens: 40, outputTokens: 20, cacheReadTokens: 8, cacheWriteTokens: 2 },
    );
    expect(d.tokens).toEqual({
      inputTokens: 60,
      outputTokens: 30,
      cacheReadTokens: 12,
      cacheWriteTokens: 3,
    });
  });

  it('treats a counter regression as a reset and charges the current value in full', () => {
    // The agent restarted its session counters behind our back. Subtracting a
    // larger baseline would book a NEGATIVE delta and credit spend back.
    const d = deltaCumulativeUsage({ inputTokens: 10 }, undefined, { inputTokens: 400 });
    expect(d.tokens.inputTokens).toBe(10);
    expect(d.snapshot?.inputTokens).toBe(10);
  });

  it('carries prior baseline fields the agent stopped reporting', () => {
    // A partial report must not invent a zero delta for the missing field, and
    // must not drop its baseline — the next full report would then double-book.
    const d = deltaCumulativeUsage({ outputTokens: 90 }, undefined, {
      inputTokens: 40,
      outputTokens: 20,
    });
    expect(d.tokens).toEqual({ outputTokens: 70 });
    expect(d.snapshot).toEqual({ inputTokens: 40, outputTokens: 90 });
  });

  it('ignores non-finite and negative counters rather than booking garbage', () => {
    const d = deltaCumulativeUsage(
      { inputTokens: Number.NaN, outputTokens: -5, cacheReadTokens: 7 },
      undefined,
      undefined,
    );
    expect(d.tokens).toEqual({ cacheReadTokens: 7 });
  });

  it('subtracts a same-currency cost baseline, case-insensitively', () => {
    const d = deltaCumulativeUsage(
      {},
      { amount: 0.42, currency: 'usd' },
      {
        cost: { amount: 0.12, currency: 'USD' },
      },
    );
    expect(d.cost).toEqual({ amount: 0.3, currency: 'usd' });
    expect(d.snapshot?.cost).toEqual({ amount: 0.42, currency: 'usd' });
  });

  it('charges a changed currency in full instead of subtracting across units', () => {
    // 0.42 EUR − 0.12 USD is not a number anyone should be billed.
    const d = deltaCumulativeUsage(
      {},
      { amount: 0.42, currency: 'EUR' },
      {
        cost: { amount: 0.12, currency: 'USD' },
      },
    );
    expect(d.cost).toEqual({ amount: 0.42, currency: 'EUR' });
  });

  it('charges a regressed cost counter in full', () => {
    const d = deltaCumulativeUsage(
      {},
      { amount: 0.05, currency: 'USD' },
      {
        cost: { amount: 0.5, currency: 'USD' },
      },
    );
    expect(d.cost?.amount).toBe(0.05);
  });

  it('preserves the prior snapshot when the agent reports nothing at all', () => {
    // Returning no snapshot here would CLEAR the persisted baseline and make
    // the next turn book the whole session total a second time.
    const d = deltaCumulativeUsage({}, undefined, { inputTokens: 40, outputTokens: 20 });
    expect(d.tokens).toEqual({});
    expect(d.snapshot).toEqual({ inputTokens: 40, outputTokens: 20 });
  });

  it('reports no snapshot when there is nothing to remember', () => {
    expect(deltaCumulativeUsage({}, undefined, undefined).snapshot).toBeUndefined();
  });
});

describe('readTokenUsage / readCost', () => {
  it('reads the spec spelling, nested under `usage` or flat', () => {
    expect(
      readTokenUsage({
        usage: { inputTokens: 1, outputTokens: 2, cachedReadTokens: 3, cachedWriteTokens: 4 },
      }),
    ).toEqual({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 });
  });

  it('accepts the snake_case / promptTokens spellings older agents emit', () => {
    expect(
      readTokenUsage({
        promptTokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 4,
      }),
    ).toEqual({ inputTokens: 1, outputTokens: 2, cacheWriteTokens: 4 });
  });

  it('drops a cost with a missing or wrongly-typed field', () => {
    expect(readCost({ amount: 1 })).toBeUndefined();
    expect(readCost({ amount: '1', currency: 'USD' })).toBeUndefined();
    expect(readCost(null)).toBeUndefined();
    expect(readCost({ amount: 1.5, currency: 'USD' })).toEqual({ amount: 1.5, currency: 'USD' });
  });
});

describe('buildUsageEvent', () => {
  it('emits nothing when the agent reported nothing worth recording', () => {
    expect(buildUsageEvent('acp', 'm', undefined, {}, undefined)).toBeUndefined();
  });

  it('withholds a non-USD amount rather than mislabelling it as costUsd', () => {
    const event = buildUsageEvent(
      'acp',
      'm',
      'high',
      { inputTokens: 5 },
      { amount: 3, currency: 'EUR' },
    );
    expect(event).toMatchObject({ type: 'usage', provider: 'acp', model: 'm', inputTokens: 5 });
    expect(event).toMatchObject({ effort: 'high' });
    expect(event && 'costUsd' in event).toBe(false);
  });

  it('omits an unconfirmed model so repricing never trusts a guess', () => {
    const event = buildUsageEvent('acp', undefined, undefined, { inputTokens: 5 }, undefined);
    expect(event && 'model' in event).toBe(false);
  });
});
