export type RouteAuthTier = "public" | "device" | "member" | "admin";

export interface RouteSecurityRegistration {
  readonly prefix: string;
  readonly owner: string;
  readonly auth: RouteAuthTier;
  readonly vaultScope: "none" | "active" | "path";
  readonly reason?: string;
}

/**
 * Runtime route-prefix registry. `buildGateway` validates its compiled prefix
 * dispatch against this table before returning, so a newly mounted HTTP
 * surface cannot boot without an explicit auth and vault-scope decision.
 */
export const ROUTE_SECURITY_REGISTRY: readonly RouteSecurityRegistration[] = [
  {
    prefix: "/_centraid-conversations",
    owner: "conversation-routes",
    auth: "device",
    vaultScope: "active",
  },
  {
    prefix: "/_centraid-user",
    owner: "user-store-routes",
    auth: "device",
    vaultScope: "active",
  },
  {
    prefix: "/centraid/_web",
    owner: "web-app-sessions",
    auth: "device",
    vaultScope: "active",
  },
  {
    prefix: "/centraid/_apps",
    owner: "apps-store-routes.ts",
    auth: "device",
    vaultScope: "active",
  },
  {
    prefix: "/centraid/_automations",
    owner: "automations-routes.ts",
    auth: "device",
    vaultScope: "active",
  },
  {
    prefix: "/centraid/_insights",
    owner: "automations-routes.ts",
    auth: "device",
    vaultScope: "active",
  },
  {
    prefix: "/centraid/_gateway/info",
    owner: "gateway-info-routes.ts",
    auth: "public",
    vaultScope: "none",
    reason: "metadata-only capability handshake",
  },
  {
    prefix: "/centraid/_gateway/tunnel",
    owner: "data-plane-control.ts",
    auth: "public",
    vaultScope: "none",
    reason:
      "protected by per-boot control secret before device identity exists",
  },
  {
    prefix: "/centraid/_gateway/devices",
    owner: "devices-routes.ts",
    auth: "device",
    vaultScope: "path",
  },
  {
    prefix: "/centraid/_gateway/members",
    owner: "members-routes.ts",
    auth: "admin",
    vaultScope: "path",
  },
  {
    prefix: "/centraid/_gateway/device-work",
    owner: "device-work-routes.ts",
    auth: "device",
    vaultScope: "path",
  },
  {
    prefix: "/centraid/_gateway/health",
    owner: "health-routes.ts",
    auth: "device",
    vaultScope: "none",
  },
  {
    prefix: "/centraid/_gateway/resource",
    owner: "resource-routes.ts",
    auth: "admin",
    vaultScope: "none",
  },
  {
    prefix: "/centraid/_gateway/capture",
    owner: "capture-routes.ts",
    auth: "device",
    vaultScope: "active",
  },
  {
    prefix: "/centraid/_gateway/diagnostics",
    owner: "diagnostics-routes.ts",
    auth: "admin",
    vaultScope: "none",
  },
  {
    prefix: "/centraid/_gateway/backup",
    owner: "backup-routes.ts",
    auth: "admin",
    vaultScope: "active",
  },
  {
    prefix: "/centraid/_gateway/storage",
    owner: "storage-routes.ts",
    auth: "admin",
    vaultScope: "none",
  },
  {
    prefix: "/centraid/_reminders",
    owner: "reminders-routes.ts",
    auth: "device",
    vaultScope: "active",
  },
  {
    prefix: "/centraid/_brief",
    owner: "reminders-routes.ts",
    auth: "device",
    vaultScope: "active",
  },
  {
    prefix: "/centraid/_logs",
    owner: "logs-routes.ts",
    auth: "admin",
    vaultScope: "none",
  },
  {
    prefix: "/centraid/_vault/assistant",
    owner: "assistant-routes.ts",
    auth: "member",
    vaultScope: "active",
  },
  {
    prefix: "/centraid/_vault/demo",
    owner: "demo-routes.ts",
    auth: "admin",
    vaultScope: "active",
  },
  {
    prefix: "/centraid/_vault/imports",
    owner: "import-routes.ts",
    auth: "member",
    vaultScope: "active",
  },
  {
    prefix: "/centraid/_vault/blobs",
    owner: "blob-routes.ts",
    auth: "device",
    vaultScope: "path",
  },
  {
    prefix: "/centraid/_vault/connections",
    owner: "connections-routes.ts",
    auth: "member",
    vaultScope: "active",
  },
  {
    prefix: "/centraid/_vault/oauth/callback",
    owner: "connections-routes.ts",
    auth: "device",
    vaultScope: "active",
  },
  {
    prefix: "/centraid/_vault/replica",
    owner: "replica-routes.ts",
    auth: "device",
    vaultScope: "path",
  },
  {
    prefix: "/centraid/_vault/changes",
    owner: "replica-routes.ts",
    auth: "device",
    vaultScope: "path",
  },
  {
    prefix: "/centraid/_vault",
    owner: "vault-routes.ts",
    auth: "member",
    vaultScope: "active",
  },
  {
    prefix: "/centraid/_templates",
    owner: "templates-routes.ts",
    auth: "device",
    vaultScope: "none",
  },
  {
    prefix: "/centraid/_agents",
    owner: "agents-routes.ts",
    auth: "device",
    vaultScope: "active",
  },
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
