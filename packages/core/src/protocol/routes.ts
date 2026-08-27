// `/centraid/_*` plane prefixes (#504). App RPC is parametric, not a plane. No new flat `/centraid/` names without a migration (docs/protocol.md).

export const GATEWAY_PLANE_PREFIX = "/centraid/_gateway" as const;

export const VAULT_PLANE_PREFIX = "/centraid/_vault" as const;

export const APPS_PLANE_PREFIX = "/centraid/_apps" as const;

export const WEB_PLANE_PREFIX = "/centraid/_web" as const;

export const BRIEF_PLANE_PREFIX = "/centraid/_brief" as const;

export const ROUTES = {
  gatewayInfo: `${GATEWAY_PLANE_PREFIX}/info`,
  gatewayHealth: `${GATEWAY_PLANE_PREFIX}/health`,
  gatewayDevices: `${GATEWAY_PLANE_PREFIX}/devices`,
  gatewayReplicaChanges: `${GATEWAY_PLANE_PREFIX}/replica/changes`,
  gatewayEdges: `${GATEWAY_PLANE_PREFIX}/edges`,
  gatewayCommons: `${GATEWAY_PLANE_PREFIX}/commons`,
  /** Durable member intents on the Commons rail: the member's own overlay. */
  gatewayCommonsIntents: `${GATEWAY_PLANE_PREFIX}/commons/intents`,
  gatewayScopedBlobs: `${GATEWAY_PLANE_PREFIX}/blobs`,
  vaultStatus: `${VAULT_PLANE_PREFIX}/status`,
  vaultErase: `${VAULT_PLANE_PREFIX}/vaults:erase`,
  vaultBlocking: `${VAULT_PLANE_PREFIX}/blocking`,
  vaultNotifications: `${VAULT_PLANE_PREFIX}/notifications`,
  vaultNotificationsEvents: `${VAULT_PLANE_PREFIX}/notifications/events`,
  vaultBlobs: `${VAULT_PLANE_PREFIX}/blobs`,
  vaultReplicaBootstrap: `${VAULT_PLANE_PREFIX}/replica/bootstrap`,
  vaultReplicaChanges: `${VAULT_PLANE_PREFIX}/changes`,
  vaultReplicaIntents: `${VAULT_PLANE_PREFIX}/replica/intents`,
  vaultScopes: `${VAULT_PLANE_PREFIX}/scopes`,
  vaultGrants: `${VAULT_PLANE_PREFIX}/grants`,
  vaultGrantSubjects: `${VAULT_PLANE_PREFIX}/grants/subjects`,
  vaultApps: `${VAULT_PLANE_PREFIX}/apps`,
  vaultConnections: `${VAULT_PLANE_PREFIX}/connections`,
  vaultConnectionProviders: `${VAULT_PLANE_PREFIX}/connections/providers`,
  vaultConnectionsAssist: `${VAULT_PLANE_PREFIX}/connections/assist`,
  vaultConnectionsAssistComplete: `${VAULT_PLANE_PREFIX}/connections/assist/complete`,
  vaultOAuthCallback: `${VAULT_PLANE_PREFIX}/oauth/callback`,
  appsList: APPS_PLANE_PREFIX,
  webSession: `${WEB_PLANE_PREFIX}/session`,
  webControl: `${WEB_PLANE_PREFIX}/control`,
  briefToday: `${BRIEF_PLANE_PREFIX}/today`,
} as const;

export type RouteName = keyof typeof ROUTES;

/** Mounts one `gatewayReplicaChanges` subscription accepts (#880). The phone
 *  attaches the same N — one wire agreement, not two budgets. */
export const MAX_MULTIPLEX_REPLICA_SCOPES = 4;

export function vaultConnectionPath(encodedConnectionId: string): string {
  return `${ROUTES.vaultConnections}/${encodedConnectionId}`;
}

export function vaultGrantPath(encodedGrantId: string): string {
  return `${ROUTES.vaultGrants}/${encodedGrantId}`;
}

export function vaultGrantRevokePath(encodedGrantId: string): string {
  return `${vaultGrantPath(encodedGrantId)}/revoke`;
}

/** The member's own withdrawal of a request that has not executed yet. */
export function commonsIntentCancelPath(encodedIntentId: string): string {
  return `${ROUTES.gatewayCommonsIntents}/${encodedIntentId}/cancel`;
}

/** The steward's per-intent answer (#872) — approve or decline, one request. */
export function commonsIntentDecidePath(encodedIntentId: string): string {
  return `${ROUTES.gatewayCommonsIntents}/${encodedIntentId}/decide`;
}

export function vaultConnectionAuthorizePath(
  encodedConnectionId: string
): string {
  return `${vaultConnectionPath(encodedConnectionId)}/authorize`;
}

export const ROUTE_PATHS: readonly string[] = Object.freeze(
  Object.values(ROUTES)
);

export function appActionPath(appId: string, action: string): string {
  return `/centraid/${encodeURIComponent(appId)}/actions/${encodeURIComponent(action)}`;
}

export function appQueryPath(appId: string, query: string): string {
  return `/centraid/${encodeURIComponent(appId)}/queries/${encodeURIComponent(query)}`;
}

export function appDescribePath(appId: string): string {
  return `/centraid/${encodeURIComponent(appId)}/_describe`;
}

export function appTurnPath(appId: string): string {
  return `/centraid/${encodeURIComponent(appId)}/_turn`;
}

export function assistantTurnPath(): string {
  return `${VAULT_PLANE_PREFIX}/assistant/_turn`;
}

export function assistantResolvePath(): string {
  return `${VAULT_PLANE_PREFIX}/assistant/resolve`;
}
