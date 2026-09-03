export interface GatewayCapabilities {
  webSessions: boolean;
  devicePairing: boolean;
  tunnel: boolean;
  backupWal: boolean;
  assistOAuth: boolean;
  automationTurns: boolean;
  multiVaultReplica: boolean;
  crossVaultPlacements: boolean;
  automations?: boolean;
  connectors?: boolean;
}

export const DEFAULT_GATEWAY_CAPABILITIES: GatewayCapabilities = Object.freeze({
  webSessions: true,
  devicePairing: true,
  tunnel: true,
  backupWal: true,
  assistOAuth: false,
  automationTurns: true,
  multiVaultReplica: true,
  crossVaultPlacements: true,
  automations: false,
  connectors: false,
});

export const OPTIONAL_GATEWAY_CAPABILITIES = [
  "automations",
  "connectors",
] as const;

export function isGatewayCapabilities(
  value: unknown
): value is GatewayCapabilities {
  if (value === null || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.webSessions === "boolean" &&
    typeof c.devicePairing === "boolean" &&
    typeof c.tunnel === "boolean" &&
    typeof c.backupWal === "boolean" &&
    typeof c.assistOAuth === "boolean" &&
    typeof c.automationTurns === "boolean" &&
    typeof c.multiVaultReplica === "boolean" &&
    typeof c.crossVaultPlacements === "boolean" &&
    (c.automations === undefined || typeof c.automations === "boolean") &&
    (c.connectors === undefined || typeof c.connectors === "boolean")
  );
}
