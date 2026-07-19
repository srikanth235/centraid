import { describe, expect, it } from 'vitest';
import { companionRequestAllowed } from './companion-access.js';

describe('Companion gateway surface', () => {
  it('allows DELETE only for the authenticated enrollment’s own existing route', () => {
    expect(
      companionRequestAllowed(
        { method: 'DELETE', url: '/centraid/_gateway/devices/enrollment-1' },
        ['locker'],
        'enrollment-1',
      ),
    ).toBe(true);
    expect(
      companionRequestAllowed(
        { method: 'DELETE', url: '/centraid/_gateway/devices/enrollment-2' },
        ['locker'],
        'enrollment-1',
      ),
    ).toBe(false);
    expect(
      companionRequestAllowed(
        { method: 'GET', url: '/centraid/_gateway/devices/enrollment-1' },
        ['locker'],
        'enrollment-1',
      ),
    ).toBe(false);
  });

  it('keeps Docs blob staging conditional on the Docs module', () => {
    const request = { method: 'POST', url: '/centraid/_vault/blobs' };
    expect(companionRequestAllowed(request, ['locker'], 'enrollment-1')).toBe(false);
    expect(companionRequestAllowed(request, ['docs'], 'enrollment-1')).toBe(true);
  });
});
