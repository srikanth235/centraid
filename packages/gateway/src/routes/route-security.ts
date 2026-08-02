export type RouteAuthTier = "public" | "device" | "member" | "admin";
export type RouteVaultScope = "none" | "active" | "path";

export interface RouteSecurityRegistration {
  readonly prefix: string;
  readonly owner: string;
  readonly auth: RouteAuthTier;
  readonly vaultScope: RouteVaultScope;
  readonly reason?: string;
}

type RouteGroupValue = string | readonly [owner: string, reason: string];

/** Build one compact, typed group while keeping the complete registry enumerable. */
function defineRouteGroup(
  auth: RouteAuthTier,
  vaultScope: RouteVaultScope,
  entries: Readonly<Record<string, RouteGroupValue>>
): readonly RouteSecurityRegistration[] {
  return Object.entries(entries).map(([prefix, value]) => {
    const [owner, reason] = typeof value === "string" ? [value] : value;
    return reason === undefined
      ? { prefix, owner, auth, vaultScope }
      : { prefix, owner, auth, vaultScope, reason };
  });
}

/**
 * Runtime route-prefix registry. `buildGateway` validates its compiled prefix
 * dispatch against this table before returning, so a newly mounted HTTP
 * surface cannot boot without an explicit auth and vault-scope decision.
 */
export const ROUTE_SECURITY_REGISTRY: readonly RouteSecurityRegistration[] = [
  ...defineRouteGroup("device", "active", {
    "/_centraid-conversations": "conversation-routes",
    "/_centraid-user": "user-store-routes",
    "/centraid/_web": "web-app-sessions",
    "/centraid/_apps": "apps-store-routes.ts",
    "/centraid/_automations": "automations-routes.ts",
    "/centraid/_insights": "automations-routes.ts",
  }),
  ...defineRouteGroup("public", "none", {
    "/centraid/_gateway/info": [
      "gateway-info-routes.ts",
      "metadata-only capability handshake",
    ],
    "/centraid/_gateway/tunnel": [
      "data-plane-control.ts",
      "protected by per-boot control secret before device identity exists",
    ],
  }),
  ...defineRouteGroup("device", "path", {
    "/centraid/_gateway/devices": "devices-routes.ts",
    "/centraid/_gateway/device-work": "device-work-routes.ts",
    "/centraid/_vault/blobs": "blob-routes.ts",
    "/centraid/_vault/replica": "replica-routes.ts",
    "/centraid/_vault/changes": "replica-routes.ts",
  }),
  ...defineRouteGroup("admin", "path", {
    "/centraid/_gateway/members": "members-routes.ts",
  }),
  ...defineRouteGroup("device", "none", {
    "/centraid/_gateway/health": "health-routes.ts",
    "/centraid/_templates": "templates-routes.ts",
  }),
  ...defineRouteGroup("admin", "none", {
    "/centraid/_gateway/resource": "resource-routes.ts",
    "/centraid/_gateway/diagnostics": "diagnostics-routes.ts",
    "/centraid/_gateway/storage": "storage-routes.ts",
    "/centraid/_logs": "logs-routes.ts",
  }),
  ...defineRouteGroup("device", "active", {
    "/centraid/_gateway/capture": "capture-routes.ts",
    "/centraid/_reminders": "reminders-routes.ts",
    "/centraid/_brief": "reminders-routes.ts",
    "/centraid/_vault/oauth/callback": "connections-routes.ts",
    "/centraid/_agents": "agents-routes.ts",
  }),
  ...defineRouteGroup("admin", "active", {
    "/centraid/_gateway/backup": "backup-routes.ts",
    "/centraid/_vault/demo": "demo-routes.ts",
  }),
  ...defineRouteGroup("member", "active", {
    "/centraid/_vault/assistant": "assistant-routes.ts",
    "/centraid/_vault/imports": "import-routes.ts",
    "/centraid/_vault/connections": "connections-routes.ts",
    "/centraid/_vault": "vault-routes.ts",
  }),
] as const;

export function assertRouteSecurityCoverage(
  registrations: readonly { prefixes: readonly string[] }[]
): void {
  const classified = new Set(ROUTE_SECURITY_REGISTRY.map((row) => row.prefix));
  const missing = registrations
    .flatMap((registration) => registration.prefixes)
    .filter((prefix) => !classified.has(prefix));
  if (missing.length)
    throw new Error(
      `unclassified gateway route prefixes: ${missing.join(", ")}`
    );
}
