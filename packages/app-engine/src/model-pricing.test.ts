import { describe, expect, it } from 'vitest';
import { priceForModel, costForUsage } from './model-pricing.js';

describe('priceForModel', () => {
  it('resolves a known model family', () => {
    const p = priceForModel('claude-opus-4-7');
    expect(p).toBeTruthy();
    expect(p!.inputPerMtok).toBe(15);
    expect(p!.outputPerMtok).toBe(75);
  });

  it('strips a provider/ prefix before matching', () => {
    expect(priceForModel('anthropic/claude-sonnet-4-6')).toEqual(
      priceForModel('claude-sonnet-4-6'),
    );
  });

  it('is case-insensitive', () => {
    expect(priceForModel('CLAUDE-HAIKU-4-5')).toEqual(priceForModel('claude-haiku-4-5'));
  });

  it('longest prefix wins — gpt-5-codex beats gpt-5', () => {
    const codex = priceForModel('gpt-5-codex');
    const base = priceForModel('gpt-5');
    expect(codex).toBeTruthy();
    expect(base).toBeTruthy();
    expect(codex!.outputPerMtok).toBe(10);
  });

  it('returns undefined for an unknown model', () => {
    expect(priceForModel('some-future-model-x')).toBe(undefined);
    expect(priceForModel(undefined)).toBe(undefined);
    expect(priceForModel('')).toBe(undefined);
  });
});

describe('costForUsage', () => {
  it('sums input + output + cache rates', () => {
    // 1M input @ $15 + 1M output @ $75 = $90.
    const cost = costForUsage('claude-opus-4-7', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBe(90);
  });

  it('prices cache reads and writes distinctly from fresh input', () => {
    // 1M cache-read @ $0.30 + 1M cache-write @ $3.75 = $4.05.
    const cost = costForUsage('claude-sonnet-4-6', {
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(cost).toBeDefined();
    expect(Math.abs(cost! - 4.05) < 1e-9).toBeTruthy();
  });

  it('treats missing token fields as zero', () => {
    expect(costForUsage('claude-haiku-4-5', {})).toBe(0);
  });

  it('returns undefined (not 0) for an unknown model — NULL stays distinct from $0', () => {
    expect(costForUsage('mystery-model', { inputTokens: 5000 })).toBe(undefined);
  });
});
