import { describe, expect, test } from 'vitest';
import { fc } from '@centraid/test-kit/fast-check';
import { costFromEntry, entryToModelPrice } from './cost.js';
import type { PricingEntry } from './types.js';

const entryArb: fc.Arbitrary<PricingEntry> = fc.record({
  input_cost_per_token: fc.option(fc.double({ min: 0, max: 1e-3, noNaN: true }), {
    nil: undefined,
  }),
  output_cost_per_token: fc.option(fc.double({ min: 0, max: 1e-3, noNaN: true }), {
    nil: undefined,
  }),
  cache_read_input_token_cost: fc.option(fc.double({ min: 0, max: 1e-3, noNaN: true }), {
    nil: undefined,
  }),
  cache_creation_input_token_cost: fc.option(fc.double({ min: 0, max: 1e-3, noNaN: true }), {
    nil: undefined,
  }),
  cache_creation_input_token_cost_above_1hr: fc.option(
    fc.double({ min: 0, max: 1e-3, noNaN: true }),
    { nil: undefined },
  ),
});

const usageArb = fc.record({
  inputTokens: fc.option(fc.integer({ min: 0, max: 100_000 }), { nil: undefined }),
  outputTokens: fc.option(fc.integer({ min: 0, max: 100_000 }), { nil: undefined }),
  cacheReadTokens: fc.option(fc.integer({ min: 0, max: 100_000 }), { nil: undefined }),
  cacheWriteTokens: fc.option(fc.integer({ min: 0, max: 100_000 }), { nil: undefined }),
});

/**
 * Pricing cost formula properties (#532 core expansion).
 *
 * Model: cost is linear in each token bucket; missing rates/tokens count as 0;
 * cache-write prefers 5m rate over 1h; per-mtok view scales by 1e6.
 */
describe('pricing cost property', () => {
  test('cost is non-negative for non-negative rates and tokens', () => {
    fc.assert(
      fc.property(entryArb, usageArb, (entry, usage) => {
        expect(costFromEntry(entry, usage)).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 48, seed: 53310 },
    );
  });

  test('empty usage yields zero cost regardless of rates', () => {
    fc.assert(
      fc.property(entryArb, (entry) => {
        expect(costFromEntry(entry, {})).toBe(0);
      }),
      { numRuns: 24, seed: 53311 },
    );
  });

  test('doubling every token bucket doubles the cost', () => {
    fc.assert(
      fc.property(entryArb, usageArb, (entry, usage) => {
        const base = costFromEntry(entry, usage);
        const doubled = costFromEntry(entry, {
          inputTokens: (usage.inputTokens ?? 0) * 2,
          outputTokens: (usage.outputTokens ?? 0) * 2,
          cacheReadTokens: (usage.cacheReadTokens ?? 0) * 2,
          cacheWriteTokens: (usage.cacheWriteTokens ?? 0) * 2,
        });
        // floating point — allow tiny relative error
        if (base === 0) expect(doubled).toBe(0);
        else expect(Math.abs(doubled - base * 2)).toBeLessThan(1e-12 * Math.max(1, Math.abs(base)));
      }),
      { numRuns: 40, seed: 53312 },
    );
  });

  test('missing rate fields contribute zero for that bucket', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (tokens) => {
        expect(costFromEntry({}, { inputTokens: tokens, outputTokens: tokens })).toBe(0);
      }),
      { numRuns: 16, seed: 53313 },
    );
  });

  test('cache-write prefers 5m rate over 1h when both present', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1e-9, max: 1e-4, noNaN: true }),
        fc.double({ min: 1e-9, max: 1e-4, noNaN: true }),
        fc.integer({ min: 1, max: 10_000 }),
        (rate5m, rate1h, tokens) => {
          fc.pre(rate5m !== rate1h);
          const cost = costFromEntry(
            {
              cache_creation_input_token_cost: rate5m,
              cache_creation_input_token_cost_above_1hr: rate1h,
            },
            { cacheWriteTokens: tokens },
          );
          expect(cost).toBeCloseTo(tokens * rate5m, 12);
        },
      ),
      { numRuns: 24, seed: 53314 },
    );
  });

  test('cache-write falls back to 1h rate when 5m is absent', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1e-9, max: 1e-4, noNaN: true }),
        fc.integer({ min: 1, max: 10_000 }),
        (rate1h, tokens) => {
          const cost = costFromEntry(
            { cache_creation_input_token_cost_above_1hr: rate1h },
            { cacheWriteTokens: tokens },
          );
          expect(cost).toBeCloseTo(tokens * rate1h, 12);
        },
      ),
      { numRuns: 16, seed: 53315 },
    );
  });

  test('entryToModelPrice scales per-token rates by 1e6', () => {
    fc.assert(
      fc.property(entryArb, (entry) => {
        const price = entryToModelPrice(entry);
        expect(price.inputPerMtok).toBeCloseTo((entry.input_cost_per_token ?? 0) * 1_000_000, 8);
        expect(price.outputPerMtok).toBeCloseTo((entry.output_cost_per_token ?? 0) * 1_000_000, 8);
        expect(price.cacheReadPerMtok).toBeCloseTo(
          (entry.cache_read_input_token_cost ?? 0) * 1_000_000,
          8,
        );
      }),
      { numRuns: 32, seed: 53316 },
    );
  });
});
