/*
 * Shared `/centraid/_*` route-path constants (issue #504 batch 2).
 *
 * Planes:
 *   - `/centraid/_gateway/*`  shell/control plane
 *   - `/centraid/_vault/*`    vault plane
 *   - `/centraid/_apps/*`     apps store plane
 *   - `/centraid/_web/*`      browser session plane
 *
 * App RPC is NOT a plane: a handler invocation is addressed under the app's
 * own prefix — `POST /centraid/<appId>/actions/<action>` (an action) and
 * `POST /centraid/<appId>/queries/<query>` (a query), with the declared
 * handlers discoverable at `GET /centraid/<appId>/_describe` (issue #505,
 * which retired the `/centraid/_tool/centraid_*` shim). Those paths are
 * per-app and parametric, so they are minted by the helpers below rather
 * than living in the flat `ROUTES` table.
 *
 * New flat top-level names under `/centraid/` without a plane prefix are
 * forbidden without a migration plan (see docs/protocol.md).
 */

/** Shell / control plane prefix. */
export const GATEWAY_PLANE_PREFIX = '/centraid/_gateway' as const;

/** Vault plane prefix. */
export const VAULT_PLANE_PREFIX = '/centraid/_vault' as const;

/** Apps plane prefix. */
export const APPS_PLANE_PREFIX = '/centraid/_apps' as const;

/** Browser session plane prefix. */
export const WEB_PLANE_PREFIX = '/centraid/_web' as const;

export const ROUTES = {
  gatewayInfo: `${GATEWAY_PLANE_PREFIX}/info`,
  gatewayHealth: `${GATEWAY_PLANE_PREFIX}/health`,
  gatewayDevices: `${GATEWAY_PLANE_PREFIX}/devices`,
  gatewayPair: `${GATEWAY_PLANE_PREFIX}/pair`,
  vaultStatus: `${VAULT_PLANE_PREFIX}/status`,
  vaultBlocking: `${VAULT_PLANE_PREFIX}/blocking`,
  vaultBlobs: `${VAULT_PLANE_PREFIX}/blobs`,
  vaultApps: `${VAULT_PLANE_PREFIX}/apps`,
  vaultConnections: `${VAULT_PLANE_PREFIX}/connections`,
  vaultConnectionProviders: `${VAULT_PLANE_PREFIX}/connections/providers`,
  vaultConnectionsAssist: `${VAULT_PLANE_PREFIX}/connections/assist`,
  vaultConnectionsAssistComplete: `${VAULT_PLANE_PREFIX}/connections/assist/complete`,
  vaultOAuthCallback: `${VAULT_PLANE_PREFIX}/oauth/callback`,
  appsList: APPS_PLANE_PREFIX,
  webSession: `${WEB_PLANE_PREFIX}/session`,
  webControl: `${WEB_PLANE_PREFIX}/control`,
} as const;

export type RouteName = keyof typeof ROUTES;

/** Dynamic routes whose identifier component must be encoded by the caller. */
export function vaultConnectionPath(encodedConnectionId: string): string {
  return `${ROUTES.vaultConnections}/${encodedConnectionId}`;
}

export function vaultConnectionAuthorizePath(encodedConnectionId: string): string {
  return `${vaultConnectionPath(encodedConnectionId)}/authorize`;
}

/** Every known absolute path constant — used by the route-literal drift check. */
export const ROUTE_PATHS: readonly string[] = Object.freeze(Object.values(ROUTES));

/**
 * Build the app-scoped action-invocation path (issue #505). `POST` here with
 * a JSON body of `{ input?, intentId? }` runs the declared action; the app id
 * and action name ride in the path, not the body.
 */
export function appActionPath(appId: string, action: string): string {
  return `/centraid/${encodeURIComponent(appId)}/actions/${encodeURIComponent(action)}`;
}

/**
 * Build the app-scoped query-invocation path (issue #505). `POST` here with a
 * JSON body of `{ input? }` runs the declared query.
 */
export function appQueryPath(appId: string, query: string): string {
  return `/centraid/${encodeURIComponent(appId)}/queries/${encodeURIComponent(query)}`;
}

/**
 * Build the app-scoped describe path (issue #505). `GET` returns the app's
 * manifest; an optional `?action=<name>` or `?query=<name>` narrows to one
 * declared handler. Replaces the `centraid_describe` tool.
 */
export function appDescribePath(appId: string): string {
  return `/centraid/${encodeURIComponent(appId)}/_describe`;
}
