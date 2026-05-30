import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { priceForModel, costForUsage } from './model-pricing.js';

describe('priceForModel', () => {
  it('resolves a known model family', () => {
    const p = priceForModel('claude-opus-4-7');
    assert.ok(p);
    assert.equal(p.inputPerMtok, 15);
    assert.equal(p.outputPerMtok, 75);
  });

  it('strips a provider/ prefix before matching', () => {
    assert.deepEqual(
      priceForModel('anthropic/claude-sonnet-4-6'),
      priceForModel('claude-sonnet-4-6'),
    );
  });

  it('is case-insensitive', () => {
    assert.deepEqual(priceForModel('CLAUDE-HAIKU-4-5'), priceForModel('claude-haiku-4-5'));
  });

  it('longest prefix wins — gpt-5-codex beats gpt-5', () => {
    const codex = priceForModel('gpt-5-codex');
    const base = priceForModel('gpt-5');
    assert.ok(codex);
    assert.ok(base);
    assert.equal(codex.outputPerMtok, 10);
  });

  it('returns undefined for an unknown model', () => {
    assert.equal(priceForModel('some-future-model-x'), undefined);
    assert.equal(priceForModel(undefined), undefined);
    assert.equal(priceForModel(''), undefined);
  });
});

describe('costForUsage', () => {
  it('sums input + output + cache rates', () => {
    // 1M input @ $15 + 1M output @ $75 = $90.
    const cost = costForUsage('claude-opus-4-7', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    assert.equal(cost, 90);
  });

  it('prices cache reads and writes distinctly from fresh input', () => {
    // 1M cache-read @ $0.30 + 1M cache-write @ $3.75 = $4.05.
    const cost = costForUsage('claude-sonnet-4-6', {
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    assert.ok(cost !== undefined);
    assert.ok(Math.abs(cost - 4.05) < 1e-9);
  });

  it('treats missing token fields as zero', () => {
    assert.equal(costForUsage('claude-haiku-4-5', {}), 0);
  });

  it('returns undefined (not 0) for an unknown model — NULL stays distinct from $0', () => {
    assert.equal(costForUsage('mystery-model', { inputTokens: 5000 }), undefined);
  });
});
