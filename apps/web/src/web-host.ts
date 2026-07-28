import type {
  CentraidGatewayRuntime,
  CentraidGatewayVaultEntry,
  CentraidSettings,
  CentraidTestConnectionInput,
} from "../../../packages/client/src/centraid-api.js";
import { pairGatewayOverIroh, purgeIrohDeviceState } from "./iroh-transport.js";
import {
  isUpdateAvailable,
  onSwUpdateAvailable,
  purgeTunnelCaches,
  requestPersistentStorage,
  watchServiceWorkerUpdates,
} from "./sw-lifecycle.js";
import { HEALTH_POLL_INTERVAL_MS, healthSnapshot } from "./web-health.js";
// governance: allow-repo-hygiene file-size-limit (#406) cohesive web host bridge owns connection identity, lifecycle events, and storage-consent teardown together
import {
  decodeTicket,
  gatewayJson,
  loadConnection,
  loadSettingsPatch,
  publish,
  saveConnection,
  saveSettingsPatch,
  subscribe,
  webGatewayId,
} from "./web-state.js";

const GATEWAY_EVENT = "gateway-changed";
const VAULT_EVENT = "vault-changed";
const METADATA_EVENT = "vault-metadata";

function settings(): CentraidSettings {
  const connection = loadConnection();
  const patch = loadSettingsPatch() as Partial<CentraidSettings>;
  return {
    activeGatewayId: "web",
    activeGatewayKind: "remote",
    activeGatewayLabel: connection.label,
    activeProfileDisplayName: connection.displayName,
    activeProfileAvatarColor: connection.avatarColor,
    gatewayUrl: window.location.origin,
    ...(connection.vaultId ? { activeVaultId: connection.vaultId } : {}),
    ...patch,
  };
}

export function installWebHost(): void {
  const api = {
    getHostCapabilities: async () => ({
      platform: "web" as const,
      appSessions: true,
      compute: {
        previews: true,
        poster: true,
        pdfText: true,
        ocr: false,
        embedding: false,
        // Web Speech cannot transcribe an existing audio/video Blob.
        transcript: false,
        edgeSeal: globalThis.crypto?.subtle !== undefined,
        backgroundTransfer: false,
      },
    }),
    getSettings: async () => settings(),
    saveSettings: async (patch: Partial<CentraidSettings>) => {
      saveSettingsPatch(patch as Record<string, unknown>);
      return settings();
    },
    getGatewayAuth: async () => {
      const connection = loadConnection();
      const gatewayId = webGatewayId(connection);
      return {
        baseUrl: window.location.origin,
        ...(gatewayId ? { gatewayId } : {}),
        ...(connection.vaultId ? { vaultId: connection.vaultId } : {}),
        ...(connection.endpointId ? { iroh: true } : {}),
        rememberDevice: connection.rememberDevice === true,
      };
    },
    listGateways: async () => {
      const connection = loadConnection();
      return connection.endpointId
        ? [
            {
              id: connection.endpointId,
              kind: "remote" as const,
              label: connection.label,
              displayName: connection.displayName,
              avatarColor: connection.avatarColor,
              endpointId: connection.endpointId,
              createdAt: new Date(0).toISOString(),
            },
          ]
        : [];
    },
    setActiveGateway: async () => settings(),
    addGateway: async (input: {
      label: string;
      endpointId: string;
      relayHint?: string;
      rememberDevice?: boolean;
    }) => {
      const previousGatewayId = webGatewayId(loadConnection());
      const next = saveConnection({
        label: input.label,
        endpointTicket: undefined,
        endpointId: input.endpointId,
        rememberDevice: input.rememberDevice === true,
      });
      if (!next.rememberDevice) purgeTunnelCaches();
      const gatewayId = webGatewayId(next);
      publish(GATEWAY_EVENT, {
        activeGatewayId: "web",
        ...(gatewayId ? { gatewayId } : {}),
        ...(previousGatewayId && previousGatewayId !== gatewayId
          ? { removedGatewayId: previousGatewayId }
          : {}),
        ...(!next.rememberDevice && gatewayId
          ? { purgeReplicaGatewayId: gatewayId }
          : {}),
      });
      return {
        id: input.endpointId,
        kind: "remote" as const,
        label: next.label,
        displayName: next.displayName,
        avatarColor: next.avatarColor,
        endpointId: input.endpointId,
        createdAt: new Date().toISOString(),
      };
    },
    removeGateway: async () => {
      const prev = loadConnection();
      const removedGatewayId = webGatewayId(prev);
      saveConnection({
        vaultId: undefined,
        endpointTicket: undefined,
        endpointId: undefined,
        rememberDevice: false,
      });
      // The tunnel caches may hold this gateway/vault's assets and blobs; drop
      // them so a later pairing to a different vault can't serve stale bytes.
      purgeTunnelCaches();
      purgeIrohDeviceState();
      publish(GATEWAY_EVENT, {
        activeGatewayId: "web",
        ...(removedGatewayId ? { removedGatewayId } : {}),
      });
      return { activeGatewayId: "web" };
    },
    renameGateway: async ({ label }: { id: string; label: string }) => {
      saveConnection({ label });
      return (await api.listGateways())[0]!;
    },
    updateProfileMetadata: async (input: {
      displayName?: string;
      avatarColor?: string;
    }) => {
      saveConnection(input);
      return (await api.listGateways())[0]!;
    },
    redeemGatewayPairing: async (input: {
      ticket: string;
      label?: string;
      rememberDevice?: boolean;
    }) => {
      const previous = loadConnection();
      const previousGatewayId = webGatewayId(previous);
      const decoded = decodeTicket(input.ticket);
      if (!decoded)
        return {
          ok: false as const,
          error: "invalid_ticket" as const,
          message: "Invalid pairing ticket.",
        };
      if (decoded.exp && decoded.exp <= Date.now()) {
        return {
          ok: false as const,
          error: "ticket_expired" as const,
          message: "This pairing ticket has expired.",
        };
      }
      try {
        if (!decoded.gw || !decoded.ticketId || !decoded.secret) {
          return {
            ok: false as const,
            error: "invalid_ticket" as const,
            message: "This ticket is missing Iroh pairing details.",
          };
        }
        const { response } = await pairGatewayOverIroh({
          endpointTicket: decoded.gw,
          ticketId: decoded.ticketId,
          secret: decoded.secret,
          deviceName: input.label ?? "Web browser",
          rememberDevice: input.rememberDevice ?? false,
        });
        if (!response.ok || !response.vaultId || !response.gatewayId) {
          throw new Error(
            response.error ?? "Gateway rejected the pairing ticket."
          );
        }
        const next = saveConnection({
          endpointTicket: decoded.gw,
          endpointId: response.gatewayId,
          vaultId: response.vaultId,
          label: input.label ?? response.gatewayName ?? "Web gateway",
          rememberDevice: input.rememberDevice ?? false,
        });
        if (input.rememberDevice !== true) purgeTunnelCaches();
        saveSettingsPatch({ onboardingCompletedAt: new Date().toISOString() });
        if (input.rememberDevice) void requestPersistentStorage();
        const gatewayId = webGatewayId(next);
        publish(GATEWAY_EVENT, {
          activeGatewayId: "web",
          ...(gatewayId ? { gatewayId } : {}),
          ...(previousGatewayId && previousGatewayId !== gatewayId
            ? { removedGatewayId: previousGatewayId }
            : {}),
          ...(input.rememberDevice !== true && gatewayId
            ? { purgeReplicaGatewayId: gatewayId }
            : {}),
        });
        publish(VAULT_EVENT, {
          activeGatewayId: "web",
          ...(gatewayId ? { gatewayId } : {}),
          activeVaultId: response.vaultId,
        });
        return {
          ok: true as const,
          gatewayId: response.gatewayId,
          vaultId: response.vaultId,
          vaultName: response.vaultName ?? decoded.vaultName ?? "Vault",
        };
      } catch (error) {
        return {
          ok: false as const,
          error: "unreachable" as const,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    testGatewayConnection: async (input: CentraidTestConnectionInput) => {
      if (input.kind === "ticket") {
        const decoded = decodeTicket(input.ticket);
        return decoded
          ? {
              ok: true,
              stages: [
                {
                  id: "decode" as const,
                  label: "Decode ticket",
                  status: "pass" as const,
                },
              ],
              ticket: {
                vaultName: decoded.vaultName ?? "Vault",
                expiresAt: new Date(decoded.exp ?? 0).toISOString(),
                gatewayEndpointId: decoded.gw ?? "",
              },
            }
          : {
              ok: false,
              error: "invalid_ticket",
              stages: [
                {
                  id: "decode" as const,
                  label: "Decode ticket",
                  status: "fail" as const,
                  detail: "Invalid ticket.",
                },
              ],
            };
      }
      if (input.kind === "gateway") {
        const connection = loadConnection();
        if (connection.endpointId) {
          try {
            await gatewayJson("/centraid/_gateway/info");
            return {
              ok: true,
              stages: [
                {
                  id: "reach" as const,
                  label: "Reach gateway over Iroh",
                  status: "pass" as const,
                },
                {
                  id: "auth" as const,
                  label: "Authenticate device",
                  status: "pass" as const,
                },
              ],
            };
          } catch (error) {
            return {
              ok: false,
              error: "unreachable",
              stages: [
                {
                  id: "reach" as const,
                  label: "Reach gateway over Iroh",
                  status: "fail" as const,
                  detail:
                    error instanceof Error ? error.message : String(error),
                },
              ],
            };
          }
        }
        return {
          ok: false,
          error: "unreachable",
          stages: [
            {
              id: "reach" as const,
              label: "Reach gateway over Iroh",
              status: "fail" as const,
            },
          ],
        };
      }
      return {
        ok: false,
        error: "unsupported",
        stages: [
          {
            id: "reach" as const,
            label: "Reach gateway over Iroh",
            status: "fail" as const,
            detail:
              "A pair ticket is the only way to reach a gateway from the browser.",
          },
        ],
      };
    },
    listGatewayVaults: async () => {
      try {
        const result = await gatewayJson<{
          vaults: CentraidGatewayVaultEntry[];
        }>("/centraid/_vault/vaults");
        return {
          ok: true as const,
          vaults: result.vaults,
        };
      } catch {
        return { ok: false as const, error: "unreachable" as const };
      }
    },
    setActiveVault: async ({ vaultId }: { vaultId?: string }) => {
      const connection = loadConnection();
      const previous = connection.vaultId;
      const next = saveConnection({ vaultId });
      if (previous !== vaultId) purgeTunnelCaches();
      publish(VAULT_EVENT, {
        activeGatewayId: "web",
        ...(webGatewayId(next) ? { gatewayId: webGatewayId(next) } : {}),
        activeVaultId: vaultId,
      });
      return settings();
    },
    getGatewayRuntime: healthSnapshot,
    onGatewayRuntime: (
      callback: (snapshot: CentraidGatewayRuntime) => void
    ) => {
      // Each poll is a full tunnel round trip. Consumers (status pill, Gateway
      // page) only need up/down, so pause polling while the tab is hidden and
      // refresh immediately on return. Nothing depends on sub-15s freshness.
      const poll = async (): Promise<void> => callback(await healthSnapshot());
      let timer: number | undefined;
      const stop = (): void => {
        if (timer !== undefined) {
          window.clearInterval(timer);
          timer = undefined;
        }
      };
      const start = (): void => {
        stop();
        void poll();
        timer = window.setInterval(() => void poll(), HEALTH_POLL_INTERVAL_MS);
      };
      const onVisibility = (): void => {
        if (document.hidden) stop();
        else start();
      };
      document.addEventListener("visibilitychange", onVisibility);
      if (!document.hidden) start();
      return () => {
        stop();
        document.removeEventListener("visibilitychange", onVisibility);
      };
    },
    onGatewayChanged: (callback: (detail: unknown) => void) =>
      subscribe(GATEWAY_EVENT, callback),
    onVaultChanged: (callback: (detail: unknown) => void) =>
      subscribe(VAULT_EVENT, callback),
    onVaultMetadataChanged: (callback: () => void) =>
      subscribe(METADATA_EVENT, callback),
    notifyVaultMetadataChanged: async () => publish(METADATA_EVENT, undefined),
    openAppFolder: async () => ({ ok: true as const }),
    getPublishStatus: async () => ({ inFlight: false }),
    onPublishEvent: () => () => {},
    getPhoneLinkStatus: async () => ({ running: false, devices: [] }),
    beginPhonePairing: async () => {
      throw new Error(
        "Phone pairing is managed by the gateway or desktop client."
      );
    },
    cancelPhonePairing: async () => undefined,
    revokePhoneDevice: async () => ({ ok: true as const }),
    onPhonePaired: () => () => {},
    restartGateway: async () => ({
      ok: false,
      error: "Restart the gateway on its host.",
    }),
    exportGatewayDiagnostics: async () => ({
      ok: false as const,
      error: "Use the gateway CLI to export diagnostics.",
    }),
    exportGatewayRecoveryKit: async () => ({
      ok: false as const,
      error: "Use the gateway CLI to export the recovery kit.",
    }),
    // No `createVault`: the browser is not any gateway's landlord. Callers
    // gate on `typeof window.CentraidApi.createVault === 'function'` and hide
    // the affordance rather than offering a button that always fails.
    deleteVault: async () => {
      throw new Error("Delete vaults on the gateway host.");
    },
    getUpdateStatus: async () => ({
      available: isUpdateAvailable(),
      version: "web",
    }),
    onUpdateAvailable: (
      callback: (msg: { available: boolean; version: string }) => void
    ) => {
      return onSwUpdateAvailable(callback);
    },
    relaunchToUpdate: async () => window.location.reload(),
    getChangelog: async () => ({ currentVersion: "web", releases: [] }),
  };

  window.CentraidApi = api as unknown as typeof window.CentraidApi;
  watchServiceWorkerUpdates();
}
