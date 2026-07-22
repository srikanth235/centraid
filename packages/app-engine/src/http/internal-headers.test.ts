import { describe, expect, it } from 'vitest';
import { companionToolAllowed } from './internal-headers.js';

describe('Companion capability profile', () => {
  const locker = new Set(['locker']);

  it('allows only the module’s pinned query and action bundle', () => {
    expect(
      companionToolAllowed(locker, 'centraid_read', {
        app: 'locker',
        query: 'autofill-item',
      }),
    ).toBe(true);
    expect(
      companionToolAllowed(locker, 'centraid_write', { app: 'locker', action: 'add-item' }),
    ).toBe(true);
    expect(
      companionToolAllowed(locker, 'centraid_write', { app: 'locker', action: 'trash-item' }),
    ).toBe(false);
  });

  it('rejects another module, describe, and malformed calls', () => {
    expect(
      companionToolAllowed(locker, 'centraid_write', { app: 'notes', action: 'create-note' }),
    ).toBe(false);
    expect(companionToolAllowed(locker, 'centraid_describe', { app: 'locker' })).toBe(false);
    expect(companionToolAllowed(locker, 'centraid_read', { app: 'locker' })).toBe(false);
  });
});
