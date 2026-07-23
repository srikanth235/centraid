import { describe, expect, it } from 'vitest';
import { companionHandlerAllowed } from './internal-headers.js';

describe('Companion capability profile', () => {
  const locker = new Set(['locker']);

  it('allows only the module’s pinned query and action bundle', () => {
    expect(companionHandlerAllowed(locker, 'query', 'locker', 'autofill-item')).toBe(true);
    expect(companionHandlerAllowed(locker, 'action', 'locker', 'add-item')).toBe(true);
    expect(companionHandlerAllowed(locker, 'action', 'locker', 'trash-item')).toBe(false);
  });

  it('rejects another module and cross-kind calls', () => {
    expect(companionHandlerAllowed(locker, 'action', 'notes', 'create-note')).toBe(false);
    // add-item is an action, not a query, on locker.
    expect(companionHandlerAllowed(locker, 'query', 'locker', 'add-item')).toBe(false);
  });
});
