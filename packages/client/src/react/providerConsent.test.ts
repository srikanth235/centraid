import { describe, expect, it } from 'vitest';
import { providerConsentWire, withProviderConsent } from './providerConsent.js';

describe('providerConsent', () => {
  it('accumulates approvals in order without duplicating one provider', () => {
    const first = withProviderConsent([], 'claude-code');
    const second = withProviderConsent(first, 'copilot');
    expect(second).toEqual(['claude-code', 'copilot']);
    expect(withProviderConsent(second, 'claude-code')).toEqual(['claude-code', 'copilot']);
  });

  it('shapes the wire value: absent, bare string, then array', () => {
    expect(providerConsentWire(undefined)).toBeUndefined();
    expect(providerConsentWire([])).toBeUndefined();
    expect(providerConsentWire(['codex'])).toBe('codex');
    expect(providerConsentWire(['codex', 'copilot'])).toEqual(['codex', 'copilot']);
  });

  it('never hands callers the array it was given', () => {
    const approved = ['codex', 'copilot'];
    expect(providerConsentWire(approved)).not.toBe(approved);
  });
});
