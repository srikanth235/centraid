/**
 * Direct tests for the shared route table (issue #545 B9) — beyond the barrel.
 */

import { describe, expect, it } from 'vitest';
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

describe('ROUTES table + plane prefixes', () => {
  it('keeps every flat path under a known plane prefix', () => {
    expect(GATEWAY_PLANE_PREFIX).toBe('/centraid/_gateway');
    expect(VAULT_PLANE_PREFIX).toBe('/centraid/_vault');
    expect(APPS_PLANE_PREFIX).toBe('/centraid/_apps');
    expect(WEB_PLANE_PREFIX).toBe('/centraid/_web');

    for (const [name, path] of Object.entries(ROUTES)) {
      expect(path.startsWith('/centraid/'), `${name}=${path}`).toBe(true);
      const underPlane =
        path.startsWith(GATEWAY_PLANE_PREFIX) ||
        path.startsWith(VAULT_PLANE_PREFIX) ||
        path === APPS_PLANE_PREFIX ||
        path.startsWith(`${APPS_PLANE_PREFIX}/`) ||
        path.startsWith(WEB_PLANE_PREFIX);
      expect(underPlane, `${name} drifted off a plane: ${path}`).toBe(true);
    }
  });

  it('ROUTE_PATHS is the frozen value set of ROUTES', () => {
    expect(ROUTE_PATHS).toStrictEqual(Object.values(ROUTES));
    expect(Object.isFrozen(ROUTE_PATHS)).toBe(true);
    expect(ROUTES.gatewayInfo).toBe('/centraid/_gateway/info');
    expect(ROUTES.appsList).toBe('/centraid/_apps');
    expect(ROUTES.webSession).toBe('/centraid/_web/session');
  });
});

describe('parametric path helpers', () => {
  it('vault connection paths encode the id component via the caller', () => {
    expect(vaultConnectionPath('conn%2F1')).toBe('/centraid/_vault/connections/conn%2F1');
    expect(vaultConnectionAuthorizePath('c1')).toBe('/centraid/_vault/connections/c1/authorize');
  });

  it('app action/query/describe paths encode both app and handler segments', () => {
    expect(appActionPath('my app', 'do it')).toBe('/centraid/my%20app/actions/do%20it');
    expect(appQueryPath('notes', 'list')).toBe('/centraid/notes/queries/list');
    expect(appDescribePath('notes')).toBe('/centraid/notes/_describe');
    expect(appDescribePath('a/b')).toBe('/centraid/a%2Fb/_describe');
  });
});
