import { describe, expect, it } from 'vitest';
import { ASSISTANT_APP_ID, isValidAppId, isValidAppOrAssistantId } from './app-paths.js';

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
    // The vault assistant's reserved scope is `_`-prefixed like any other
    // plugin-internal id — `isValidAppId` alone still rejects it; see
    // `isValidAppOrAssistantId` for the gate that allows it through.
    expect(isValidAppId(ASSISTANT_APP_ID)).toBe(false);
  });
});

describe('isValidAppOrAssistantId', () => {
  it('accepts everything isValidAppId accepts', () => {
    expect(isValidAppOrAssistantId('crm')).toBe(true);
    expect(isValidAppOrAssistantId('standup-bot')).toBe(true);
  });

  it('additionally allows the reserved `_assistant` scope', () => {
    expect(isValidAppOrAssistantId(ASSISTANT_APP_ID)).toBe(true);
  });

  it('still rejects other `_`-prefixed (plugin-internal) ids', () => {
    expect(isValidAppOrAssistantId('_internal')).toBe(false);
    expect(isValidAppOrAssistantId('_assistant2')).toBe(false);
  });
});
