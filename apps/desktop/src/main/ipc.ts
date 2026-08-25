// governance: allow-repo-hygiene file-size-limit ipc-hub pending split per-feature handler modules (harness, conversation, apps, provider) once the surface stabilizes
import { app, ipcMain, BrowserWindow, safeStorage, shell } from "electron";

import { resolveAppRevealDir, resetAppSessions } from "./app-sessions.js";
import { resetAppsStoreAuthCache } from "./apps-store-client.js";
import { refreshAuthInjector } from "./auth-injector.js";
import { getChangelog } from "./changelog.js";
import { testGatewayConnection } from "./gateway-connectivity.js";
import type {
  ConnectivityReport,
  TestConnectionInput,
} from "./gateway-connectivity.js";
import {
  getGatewayRuntimeSnapshot,
  nudgeGatewayMonitor,
} from "./gateway-monitor.js";
import { redeemGatewayPairing } from "./gateway-pairing.js";
import type {
  RedeemGatewayPairingInput,
  RedeemGatewayPairingResult,
} from "./gateway-pairing.js";
import {
  GatewayError,
  listGateways,
  removeGateway,
  renameGateway,
  updateGatewayRememberDevice,
  updateProfileMetadata,
} from "./gateway-store.js";
import type { GatewayProfile } from "./gateway-store.js";
import { listGatewayVaults } from "./gateway-vaults.js";
import type { ListGatewayVaultsResult } from "./gateway-vaults.js";
import {
  Channel,
  gatewayChangedPayload,
  keychainPromptExpected,
  vaultChangedPayload,
} from "./ipc-core.js";
import { applyLaunchAtLogin } from "./login-item.js";
import {
  beginPhonePairing,
  cancelPhonePairing,
  phoneLinkStatus,
  revokePhoneDevice,
} from "./phone-link.js";
import {
  loadPersistedSettings,
  loadSettings,
  requestLocalGatewayStart,
  saveSettings,
  setActiveGatewayId,
  setActiveVaultId,
} from "./settings.js";
import type { DesktopSettings } from "./settings.js";
import {
  checkForUpdatesManual,
  getUpdateStatus,
  relaunchToUpdate,
} from "./update-watcher.js";

/** No publish queue — always "not in flight". */
type PublishStatus = {
  inFlight: boolean;
  lastError?: string;
  lastPublishedAt?: number;
};
const getPublishStatus = (_id: string): PublishStatus => ({ inFlight: false });

export function registerIpcHandlers(): void {
  const broadcastGatewayChanged = (
    next: DesktopSettings,
    detail: { removedGatewayId?: string; purgeReplicaGatewayId?: string } = {}
  ): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(
        Channel.GATEWAY_CHANGED,
        gatewayChangedPayload(next, detail)
      );
    }
  };

  const invalidateGatewayCaches = async (): Promise<void> => {
    resetAppsStoreAuthCache();
    // Editing sessions are per-gateway — worktrees live in the previous git store.
    resetAppSessions();
    await refreshAuthInjector();
  };

  // Vault pointer only (#289): drop auth caches, NOT app-editing sessions.
  const invalidateVaultCaches = async (): Promise<void> => {
    resetAppsStoreAuthCache();
    await refreshAuthInjector();
  };

  const broadcastVaultChanged = (next: DesktopSettings): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(Channel.VAULT_CHANGED, vaultChangedPayload(next));
    }
  };

  // Token's single bridge crossing: this payload must never carry `gatewayToken`.
  ipcMain.handle(Channel.SETTINGS_GET, async () => {
    const { gatewayToken: _gatewayToken, ...rest } = await loadSettings();
    return rest;
  });
  ipcMain.handle(
    Channel.SETTINGS_SAVE,
    async (_e, patch: Partial<DesktopSettings>) => {
      const next = await saveSettings(patch);
      await invalidateGatewayCaches();
      nudgeGatewayMonitor();
      if ("launchAtLogin" in patch) applyLaunchAtLogin(next.launchAtLogin);
      return next;
    }
  );
  // Local gateway is not removable. Tokens never cross the bridge (#109).
  ipcMain.handle(
    Channel.GATEWAYS_LIST,
    async (): Promise<GatewayProfile[]> => listGateways()
  );

  // No "add gateway by URL + token" IPC (#505) — pairing calls `addGateway` in-process.

  ipcMain.handle(
    Channel.GATEWAYS_UPDATE_METADATA,
    async (
      _e,
      input: { id: string; displayName?: string; avatarColor?: string }
    ): Promise<GatewayProfile> => {
      const updated = await updateProfileMetadata(input.id, {
        ...(input.displayName === undefined
          ? {}
          : { displayName: input.displayName }),
        ...(input.avatarColor === undefined
          ? {}
          : { avatarColor: input.avatarColor }),
      });
      const next = await loadSettings();
      broadcastGatewayChanged(next);
      return updated;
    }
  );

  ipcMain.handle(
    Channel.GATEWAYS_REMOVE,
    async (_e, input: { id: string }): Promise<{ activeGatewayId: string }> => {
      try {
        await removeGateway(input.id);
      } catch (error) {
        if (
          error instanceof GatewayError &&
          error.code === "local_not_removable"
        ) {
          throw new Error(error.message, { cause: error });
        }
        throw error;
      }
      const current = await loadSettings();
      let next: DesktopSettings = current;
      if (current.activeGatewayId === input.id) {
        next = await setActiveGatewayId("local");
      }
      await invalidateGatewayCaches();
      broadcastGatewayChanged(next, { removedGatewayId: input.id });
      return { activeGatewayId: next.activeGatewayId };
    }
  );

  ipcMain.handle(
    Channel.GATEWAYS_RENAME,
    async (
      _e,
      input: { id: string; label: string }
    ): Promise<GatewayProfile> => {
      const updated = await renameGateway(input.id, input.label);
      const next = await loadSettings();
      broadcastGatewayChanged(next);
      return updated;
    }
  );

  ipcMain.handle(
    Channel.GATEWAYS_SET_ACTIVE,
    async (_e, input: { id: string }): Promise<DesktopSettings> => {
      const next = await setActiveGatewayId(input.id);
      const { shutdownAllLocalGatewaysExcept } =
        await import("./local-gateway.js");
      await shutdownAllLocalGatewaysExcept(
        next.activeGatewayKind === "local" ? next.activeGatewayId : undefined
      );
      // Else a dormant QUIC dialer accumulates per switch (#289).
      const { closeAllIrohDialersExcept } = await import("./iroh-dialer.js");
      await closeAllIrohDialersExcept(
        next.activeGatewayKind === "remote" ? next.activeGatewayId : undefined
      );
      await invalidateGatewayCaches();
      broadcastGatewayChanged(next);
      nudgeGatewayMonitor();
      return next;
    }
  );

  // Pairing enrolls one vault: flip BOTH pointers; repeat SET_ACTIVE teardown.
  ipcMain.handle(
    Channel.GATEWAY_PAIR_REDEEM,
    async (
      _e,
      input: RedeemGatewayPairingInput
    ): Promise<RedeemGatewayPairingResult> => {
      const result = await redeemGatewayPairing(input);
      if (result.ok) {
        const next = await loadSettings();
        const { shutdownAllLocalGatewaysExcept } =
          await import("./local-gateway.js");
        await shutdownAllLocalGatewaysExcept(
          next.activeGatewayKind === "local" ? next.activeGatewayId : undefined
        );
        const { closeAllIrohDialersExcept } = await import("./iroh-dialer.js");
        await closeAllIrohDialersExcept(
          next.activeGatewayKind === "remote" ? next.activeGatewayId : undefined
        );
        await invalidateGatewayCaches();
        broadcastGatewayChanged(
          next,
          input.rememberDevice === true
            ? {}
            : { purgeReplicaGatewayId: result.gatewayId }
        );
        broadcastVaultChanged(next);
        nudgeGatewayMonitor();
      }
      return result;
    }
  );

  // List vaults WITHOUT switching (#376) — no invalidation or broadcast.
  ipcMain.handle(
    Channel.GATEWAYS_LIST_VAULTS,
    async (
      _e,
      input: { gatewayId: string }
    ): Promise<ListGatewayVaultsResult> => listGatewayVaults(input.gatewayId)
  );

  // Never throws (#382): every failure is a failed stage in the report.
  ipcMain.handle(
    Channel.GATEWAY_TEST_CONNECTION,
    async (_e, input: TestConnectionInput): Promise<ConnectivityReport> =>
      testGatewayConnection(input)
  );

  // Client-side pointer flip (#289): no server call, no session teardown.
  ipcMain.handle(
    Channel.VAULTS_SET_ACTIVE,
    async (_e, input: { vaultId?: string }): Promise<DesktopSettings> => {
      const next = await setActiveVaultId(input.vaultId);
      await invalidateVaultCaches();
      broadcastVaultChanged(next);
      return next;
    }
  );

  // Create/delete is LOCAL only — remote is a host-side admin act.
  const assertLocalAdmin = async (): Promise<string> => {
    const settings = await loadSettings();
    if (settings.activeGatewayKind !== "local") {
      throw new Error(
        "Vault create/delete on a remote gateway is a server-side admin act — " +
          "run `centraid-gateway vault …` with the CLI on the gateway host."
      );
    }
    return settings.activeGatewayId;
  };

  ipcMain.handle(
    Channel.VAULTS_CREATE,
    async (_e, input: { name?: string }): Promise<{ vaultId: string }> => {
      const gatewayId = await assertLocalAdmin();
      const { createLocalVault } = await import("./local-gateway.js");
      return await createLocalVault(gatewayId, input.name);
    }
  );

  ipcMain.handle(
    Channel.VAULTS_DELETE,
    async (
      _e,
      input: { vaultId: string; name: string }
    ): Promise<{ deleted: true }> => {
      const gatewayId = await assertLocalAdmin();
      const settings = await loadSettings();
      // Never delete the currently addressed vault — clear the pointer first.
      let next: DesktopSettings | undefined;
      if (settings.activeVaultId === input.vaultId) {
        next = await setActiveVaultId(undefined);
        await invalidateVaultCaches();
      }
      const { deleteLocalVault } = await import("./local-gateway.js");
      await deleteLocalVault(gatewayId, input.vaultId, input.name);
      // Else the shell keeps showing the deleted vault's name (#382).
      if (next) broadcastVaultChanged(next);
      return { deleted: true };
    }
  );

  // Metadata-only: VAULT_METADATA_PUSH, not VAULT_CHANGED (would reScope Home).
  ipcMain.handle(Channel.VAULT_METADATA_CHANGED, (): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(Channel.VAULT_METADATA_PUSH);
    }
  });

  // Harness detection belongs on the gateway — never add a desktop-side probe.

  // App lifecycle is HTTP, not IPC. APPS_OPEN stays LOCAL-ONLY (#141).

  ipcMain.handle(Channel.APPS_OPEN, async (_e, input: { id: string }) => {
    const dir = await resolveAppRevealDir(input.id);
    // `shell.openPath` RESOLVES with an error string — a bare await swallows failure.
    const openErr = await shell.openPath(dir);
    if (openErr) throw new Error(`Could not open ${dir}: ${openErr}`);
    return { ok: true };
  });

  ipcMain.handle(
    Channel.PUBLISH_STATUS,
    async (_e, input: { id: string }): Promise<PublishStatus> =>
      getPublishStatus(input.id)
  );

  ipcMain.handle(Channel.GATEWAY_RUNTIME_GET, async () =>
    getGatewayRuntimeSnapshot()
  );

  // LOCAL only. Fresh per-launch bearer — invalidate caches and re-broadcast.
  ipcMain.handle(
    Channel.GATEWAY_RESTART,
    async (): Promise<{ ok: boolean; error?: string }> => {
      const settings = await loadSettings();
      if (settings.activeGatewayKind !== "local") {
        return { ok: false, error: "remote gateways restart server-side" };
      }
      try {
        requestLocalGatewayStart();
        const { restartLocalGateway } = await import("./local-gateway.js");
        await restartLocalGateway(settings.activeGatewayId);
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      await invalidateGatewayCaches();
      const next = await loadSettings();
      broadcastGatewayChanged(next);
      nudgeGatewayMonitor();
      return { ok: true };
    }
  );

  // Cannot use GATEWAY_RESTART: `loadSettings()` is the failing call. Read
  // persisted settings only.
  ipcMain.handle(
    Channel.GATEWAY_START_RETRY,
    async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        const persisted = await loadPersistedSettings();
        const profile = (await listGateways()).find(
          (row) => row.id === persisted.activeGatewayId
        );
        if (profile && profile.kind !== "local") {
          return { ok: false, error: "remote gateways restart server-side" };
        }
        requestLocalGatewayStart();
        const { retryLocalGatewayStart } = await import("./local-gateway.js");
        await retryLocalGatewayStart(persisted.activeGatewayId);
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      await invalidateGatewayCaches().catch((error: unknown) => {
        console.warn(
          "[gateway] cache refresh after a start retry failed",
          error
        );
      });
      nudgeGatewayMonitor();
      return { ok: true };
    }
  );

  ipcMain.handle(Channel.GATEWAY_DIAGNOSTICS_EXPORT, async () => {
    const { exportActiveGatewayDiagnostics } = await import("./gateway-ops.js");
    return exportActiveGatewayDiagnostics();
  });
  ipcMain.handle(
    Channel.GATEWAY_RECOVERY_KIT_EXPORT,
    async (_event, input: { password: string }) => {
      const { exportActiveGatewayRecoveryKit } =
        await import("./gateway-ops.js");
      return exportActiveGatewayRecoveryKit(input);
    }
  );

  ipcMain.handle(
    Channel.GATEWAY_AUTH_GET,
    async (): Promise<{
      baseUrl: string;
      gatewayId: string;
      token?: string;
      vaultId?: string;
      rememberDevice: boolean;
    }> => {
      const settings = await loadSettings();
      const profile = (await listGateways()).find(
        (candidate) => candidate.id === settings.activeGatewayId
      );
      return {
        baseUrl: settings.gatewayUrl.replace(/\/+$/u, ""),
        gatewayId: profile?.id ?? settings.activeGatewayId,
        token: settings.gatewayToken || undefined,
        rememberDevice: profile?.rememberDevice === true,
        // `x-centraid-vault`; undefined lets the gateway pick (#289).
        ...(settings.activeVaultId === undefined
          ? {}
          : { vaultId: settings.activeVaultId }),
      };
    }
  );

  // Pairing defaults offline-copy ON. OFF must reuse redeem's purge or the replica is orphaned.
  ipcMain.handle(
    Channel.GATEWAY_REMEMBER_DEVICE_SET,
    async (
      _event,
      input: { rememberDevice: boolean }
    ): Promise<{ rememberDevice: boolean }> => {
      const settings = await loadSettings();
      const profile = await updateGatewayRememberDevice(
        settings.activeGatewayId,
        input.rememberDevice === true
      );
      broadcastGatewayChanged(
        settings,
        profile.rememberDevice === true
          ? {}
          : { purgeReplicaGatewayId: profile.id }
      );
      return { rememberDevice: profile.rememberDevice === true };
    }
  );

  // Phone link (#263): tunnel + allowlist live in main.
  ipcMain.handle(Channel.PHONE_STATUS, async () => phoneLinkStatus());
  ipcMain.handle(Channel.PHONE_BEGIN_PAIRING, async () => beginPhonePairing());
  ipcMain.handle(Channel.PHONE_CANCEL_PAIRING, async () => {
    cancelPhonePairing();
    return { ok: true as const };
  });
  ipcMain.handle(
    Channel.PHONE_REVOKE,
    async (_e, input: { deviceId: string }) => {
      const removed = revokePhoneDevice(input.deviceId);
      return { removed: Boolean(removed) };
    }
  );

  ipcMain.handle(Channel.UPDATE_STATUS, async () => getUpdateStatus());
  ipcMain.handle(Channel.UPDATE_CHECK, async () => checkForUpdatesManual());
  ipcMain.handle(
    Channel.GATEWAY_SERVICE_INSTALL,
    async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      const { installGatewayOsService } = await import("./detached-gateway.js");
      const { localGatewayDataDir } = await import("./gateway-paths.js");
      return installGatewayOsService(localGatewayDataDir());
    }
  );
  ipcMain.handle(Channel.UPDATE_RELAUNCH, async () => {
    relaunchToUpdate();
    return { ok: true as const };
  });

  // Warn BEFORE the OS credential dialog (#603).
  ipcMain.handle(Channel.KEYCHAIN_PROMPT_EXPECTED, (): boolean =>
    keychainPromptExpected({
      platform: process.platform,
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      packaged: app.isPackaged,
    })
  );

  ipcMain.handle(Channel.CHANGELOG_GET, async () => getChangelog());

  // Templates/automations/insights are HTTP — never add IPC.
}
