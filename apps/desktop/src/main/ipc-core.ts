export const Channel = {
  SETTINGS_GET: "centraid:settings:get",
  SETTINGS_SAVE: "centraid:settings:save",

  APPS_OPEN: "centraid:apps:open",

  PUBLISH_STATUS: "centraid:publish:status",
  PUBLISH_EVENT: "centraid:publish:event",

  GATEWAYS_LIST: "centraid:gateways:list",
  GATEWAYS_REMOVE: "centraid:gateways:remove",
  GATEWAYS_RENAME: "centraid:gateways:rename",
  GATEWAYS_UPDATE_METADATA: "centraid:gateways:update-metadata",
  GATEWAYS_SET_ACTIVE: "centraid:gateways:set-active",
  GATEWAY_CHANGED: "centraid:gateways:changed",
  GATEWAY_PAIR_REDEEM: "centraid:gateways:pair-redeem",
  GATEWAYS_LIST_VAULTS: "centraid:gateways:list-vaults",
  GATEWAY_TEST_CONNECTION: "centraid:gateways:test-connection",
  VAULTS_SET_ACTIVE: "centraid:vaults:set-active",
  VAULT_CHANGED: "centraid:vaults:changed",
  VAULTS_CREATE: "centraid:vaults:create",
  VAULTS_DELETE: "centraid:vaults:delete",
  VAULT_METADATA_CHANGED: "centraid:vaults:metadata-changed",
  VAULT_METADATA_PUSH: "centraid:vaults:metadata-push",
  GATEWAY_AUTH_GET: "centraid:gateways:auth",
  GATEWAY_REMEMBER_DEVICE_SET: "centraid:gateways:set-remember-device",
  GATEWAY_RUNTIME_GET: "centraid:gateway-runtime:get",
  GATEWAY_RUNTIME_EVENT: "centraid:gateway-runtime:event",
  GATEWAY_RESTART: "centraid:gateway-runtime:restart",
  GATEWAY_START_RETRY: "centraid:gateway-runtime:retry-start",
  GATEWAY_DIAGNOSTICS_EXPORT: "centraid:gateway-runtime:export-diagnostics",
  GATEWAY_RECOVERY_KIT_EXPORT: "centraid:gateway-runtime:export-recovery-kit",

  PHONE_STATUS: "centraid:phone:status",
  PHONE_BEGIN_PAIRING: "centraid:phone:begin-pairing",
  PHONE_CANCEL_PAIRING: "centraid:phone:cancel-pairing",
  PHONE_REVOKE: "centraid:phone:revoke",
  PHONE_PAIRED: "centraid:phone:paired",

  UPDATE_STATUS: "centraid:update:status",
  UPDATE_CHECK: "centraid:update:check",
  UPDATE_RELAUNCH: "centraid:update:relaunch",
  GATEWAY_SERVICE_INSTALL: "centraid:gateway:service-install",
  UPDATE_AVAILABLE: "centraid:update:available",

  KEYCHAIN_PROMPT_EXPECTED: "centraid:keychain:prompt-expected",

  CHANGELOG_GET: "centraid:changelog:get",
  DEEP_LINK: "centraid:deep-link",
} as const;

export interface GatewayChangedSettings {
  activeGatewayId: string;
  activeGatewayKind: "local" | "remote";
  activeGatewayLabel: string;
  activeProfileDisplayName: string;
  activeProfileAvatarColor: string;
}

export interface GatewayChangedDetail {
  removedGatewayId?: string;
  purgeReplicaGatewayId?: string;
}

export function gatewayChangedPayload(
  next: GatewayChangedSettings,
  detail: GatewayChangedDetail = {}
): {
  activeGatewayId: string;
  activeGatewayKind: "local" | "remote";
  activeGatewayLabel: string;
  activeProfileDisplayName: string;
  activeProfileAvatarColor: string;
  gatewayId: string;
  removedGatewayId?: string;
  purgeReplicaGatewayId?: string;
} {
  return {
    activeGatewayId: next.activeGatewayId,
    activeGatewayKind: next.activeGatewayKind,
    activeGatewayLabel: next.activeGatewayLabel,
    activeProfileDisplayName: next.activeProfileDisplayName,
    activeProfileAvatarColor: next.activeProfileAvatarColor,
    gatewayId: next.activeGatewayId,
    ...detail,
  };
}

export function vaultChangedPayload(next: {
  activeGatewayId: string;
  activeVaultId?: string;
}): {
  activeGatewayId: string;
  gatewayId: string;
  activeVaultId?: string;
} {
  return {
    activeGatewayId: next.activeGatewayId,
    gatewayId: next.activeGatewayId,
    ...(next.activeVaultId === undefined
      ? {}
      : { activeVaultId: next.activeVaultId }),
  };
}

export function keychainPromptExpected(host: {
  platform: NodeJS.Platform;
  encryptionAvailable: boolean;
  packaged: boolean;
}): boolean {
  if (!host.encryptionAvailable) return false;
  if (host.platform === "darwin") return !host.packaged;
  if (host.platform === "linux") return true;
  return false;
}

const APP_ID_GRAMMAR = /^[a-z0-9][a-z0-9-]{0,62}$/u;

export function assertRevealableAppId(appId: string): void {
  if (!APP_ID_GRAMMAR.test(appId) || appId.startsWith("_")) {
    throw new Error(
      `invalid app id ${JSON.stringify(
        appId
      )} — expected lowercase a-z / 0-9 / "-", no leading "_"`
    );
  }
}

export function parseRevealableAppId(input: unknown): string {
  const id =
    input && typeof input === "object"
      ? (input as { id?: unknown }).id
      : undefined;
  if (typeof id !== "string") {
    throw new Error("app open needs { id }");
  }
  assertRevealableAppId(id);
  return id;
}

export function hostCapabilities(): {
  platform: "desktop";
  compute: {
    previews: true;
    poster: true;
    pdfText: true;
    ocr: false;
    embedding: false;
    transcript: false;
    edgeSeal: true;
    backgroundTransfer: false;
  };
} {
  return {
    platform: "desktop",
    compute: {
      previews: true,
      poster: true,
      pdfText: true,
      ocr: false,
      embedding: false,
      transcript: false,
      edgeSeal: true,
      backgroundTransfer: false,
    },
  };
}
