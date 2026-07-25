import { describe, expect, test } from 'vitest';
import { DEFAULT_GATEWAY_CAPABILITIES, isGatewayCapabilities } from './capabilities.js';
import {
  APPS_PLANE_PREFIX,
  GATEWAY_PLANE_PREFIX,
  ROUTE_PATHS,
  ROUTES,
  VAULT_PLANE_PREFIX,
  WEB_PLANE_PREFIX,
  appActionPath,
  appDescribePath,
  appQueryPath,
  vaultConnectionAuthorizePath,
  vaultConnectionPath,
} from './routes.js';

describe('protocol routes table (#545 B9)', () => {
  test('plane prefixes are stable under /centraid/_', () => {
    expect(GATEWAY_PLANE_PREFIX).toBe('/centraid/_gateway');
    expect(VAULT_PLANE_PREFIX).toBe('/centraid/_vault');
    expect(APPS_PLANE_PREFIX).toBe('/centraid/_apps');
    expect(WEB_PLANE_PREFIX).toBe('/centraid/_web');
  });

  test('every ROUTES value is listed in ROUTE_PATHS and uses a plane prefix', () => {
    const values = Object.values(ROUTES);
    expect(ROUTE_PATHS).toEqual(values);
    for (const path of values) {
      expect(
        path.startsWith(GATEWAY_PLANE_PREFIX) ||
          path.startsWith(VAULT_PLANE_PREFIX) ||
          path.startsWith(APPS_PLANE_PREFIX) ||
          path.startsWith(WEB_PLANE_PREFIX),
      ).toBe(true);
    }
  });

  test('dynamic helpers encode path segments', () => {
    expect(vaultConnectionPath('conn%2F1')).toBe(`${ROUTES.vaultConnections}/conn%2F1`);
    expect(vaultConnectionAuthorizePath('x')).toBe(`${ROUTES.vaultConnections}/x/authorize`);
    expect(appActionPath('my app', 'do it')).toBe('/centraid/my%20app/actions/do%20it');
    expect(appQueryPath('a', 'q')).toBe('/centraid/a/queries/q');
    expect(appDescribePath('kit')).toBe('/centraid/kit/_describe');
  });
});

describe('protocol capabilities (#545 B9)', () => {
  test('DEFAULT_GATEWAY_CAPABILITIES freezes expected shape', () => {
    expect(isGatewayCapabilities(DEFAULT_GATEWAY_CAPABILITIES)).toBe(true);
    expect(DEFAULT_GATEWAY_CAPABILITIES).toEqual({
      webSessions: true,
      devicePairing: true,
      tunnel: true,
      backupWal: true,
      assistOAuth: false,
    });
  });

  test('isGatewayCapabilities rejects non-objects and missing fields', () => {
    expect(isGatewayCapabilities(null)).toBe(false);
    expect(isGatewayCapabilities({})).toBe(false);
    expect(isGatewayCapabilities({ webSessions: true })).toBe(false);
    expect(isGatewayCapabilities({ ...DEFAULT_GATEWAY_CAPABILITIES })).toBe(true);
    expect(
      isGatewayCapabilities({
        webSessions: true,
        devicePairing: true,
        tunnel: true,
        backupWal: true,
      }),
    ).toBe(true);
  });
});
