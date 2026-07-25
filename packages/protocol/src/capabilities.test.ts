/**
 * Direct tests for the capability map (issue #545 B9).
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_GATEWAY_CAPABILITIES, isGatewayCapabilities } from './capabilities.js';

describe('DEFAULT_GATEWAY_CAPABILITIES', () => {
  it('is frozen and advertises the modern loopback surface', () => {
    expect(Object.isFrozen(DEFAULT_GATEWAY_CAPABILITIES)).toBe(true);
    expect(DEFAULT_GATEWAY_CAPABILITIES).toEqual({
      webSessions: true,
      devicePairing: true,
      tunnel: true,
      backupWal: true,
      assistOAuth: false,
      automationTurns: true,
    });
  });
});

describe('isGatewayCapabilities', () => {
  it('accepts the required booleans and optional assistOAuth / automationTurns', () => {
    expect(isGatewayCapabilities(null)).toBe(false);
    expect(isGatewayCapabilities('x')).toBe(false);
    expect(isGatewayCapabilities({})).toBe(false);
    expect(
      isGatewayCapabilities({
        webSessions: true,
        devicePairing: true,
        tunnel: false,
        backupWal: true,
      }),
    ).toBe(true);
    expect(
      isGatewayCapabilities({
        webSessions: true,
        devicePairing: true,
        tunnel: true,
        backupWal: true,
        assistOAuth: true,
        automationTurns: true,
      }),
    ).toBe(true);
    expect(
      isGatewayCapabilities({
        webSessions: true,
        devicePairing: true,
        tunnel: true,
        backupWal: true,
        assistOAuth: 'yes',
      }),
    ).toBe(false);
    expect(
      isGatewayCapabilities({
        webSessions: true,
        devicePairing: true,
        tunnel: true,
        backupWal: true,
        automationTurns: 'yes',
      }),
    ).toBe(false);
    expect(
      isGatewayCapabilities({
        webSessions: true,
        devicePairing: true,
        tunnel: true,
        backupWal: 'true',
      }),
    ).toBe(false);
  });
});
