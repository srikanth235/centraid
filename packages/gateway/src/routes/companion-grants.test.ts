import { describe, expect, it } from 'vitest';
import { companionModuleState } from './companion-grants.js';

describe('Companion module grant state', () => {
  it('goes dark when the required scope is revoked despite another active grant', () => {
    const selected = new Set(['locker']);
    const unrelatedOnly = {
      grants: [{ scopes: [{ schema: 'locker', table: 'item', verbs: 'read' }] }],
    };
    expect(companionModuleState(selected, 'locker', unrelatedOnly)).toBe('parked');
  });

  it('accepts the exact reveal grant and schema-wide combined verbs', () => {
    expect(
      companionModuleState(new Set(['locker']), 'locker', {
        grants: [{ scopes: [{ schema: 'locker', table: 'item', verbs: 'reveal' }] }],
      }),
    ).toBe('granted');
    expect(
      companionModuleState(new Set(['people']), 'people', {
        grants: [{ scopes: [{ schema: 'people', table: null, verbs: 'read+act' }] }],
      }),
    ).toBe('granted');
  });

  it('distinguishes profile revocation from an unavailable app', () => {
    expect(companionModuleState(new Set(), 'notes', { grants: [] })).toBe('revoked');
    expect(companionModuleState(new Set(['notes']), 'notes', undefined)).toBe('unavailable');
  });
});
