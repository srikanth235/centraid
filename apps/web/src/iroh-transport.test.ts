import { beforeEach, describe, expect, test } from 'vitest';

import { irohBridgeIdForConsent, moveIrohDeviceKeyForConsent } from './iroh-transport.js';

const DEVICE_KEY = 'centraid.web.v1.iroh-device-key';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('Iroh remember-device boundaries', () => {
  test('moves one stable device key between session and durable storage', () => {
    sessionStorage.setItem(DEVICE_KEY, 'stable-key');
    expect(moveIrohDeviceKeyForConsent(true)).toBe('stable-key');
    expect(localStorage.getItem(DEVICE_KEY)).toBe('stable-key');
    expect(sessionStorage.getItem(DEVICE_KEY)).toBeNull();

    expect(moveIrohDeviceKeyForConsent(false)).toBe('stable-key');
    expect(sessionStorage.getItem(DEVICE_KEY)).toBe('stable-key');
    expect(localStorage.getItem(DEVICE_KEY)).toBeNull();
  });

  test('marks only remembered bridge scopes as durable-cache eligible', () => {
    const scope = '00000000-0000-4000-8000-000000000001';
    expect(irohBridgeIdForConsent(true, scope)).toBe(`d-${scope}`);
    expect(irohBridgeIdForConsent(false, scope)).toBe(`e-${scope}`);
  });
});
