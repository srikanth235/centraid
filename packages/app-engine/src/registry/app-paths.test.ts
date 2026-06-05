import { describe, expect, it } from 'vitest';
import { isValidAppId } from './app-paths.js';

describe('isValidAppId', () => {
  it('accepts plain-slug app folder ids', () => {
    expect(isValidAppId('crm')).toBe(true);
    expect(isValidAppId('standup-bot')).toBe(true);
    expect(isValidAppId('My_App-2')).toBe(true);
  });

  it('rejects dotted / path-unsafe / plugin-internal ids', () => {
    expect(isValidAppId('')).toBe(false);
    expect(isValidAppId('_internal')).toBe(false);
    expect(isValidAppId('a/b')).toBe(false);
    expect(isValidAppId('up..dir')).toBe(false);
    // Dots are no longer part of the grammar — the legacy `auto.` prefix
    // is gone; automation apps are marked by the manifest `kind` field.
    expect(isValidAppId('auto.standup-bot')).toBe(false);
  });
});
