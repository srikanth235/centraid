// governance: allow-repo-hygiene file-size-limit ipc-hub pending split per-feature handler modules (agent, chat, apps, provider) once the surface stabilizes
import { app, ipcMain, BrowserWindow, safeStorage, shell } from "electron";

import { resolveAppRevealDir, resetAppSessions } from "./app-sessions.js";
import { resetAppsStoreAuthCache } from "./apps-store-client.js";
import { refreshAuthInjector } from "./auth-injector.js";
import { getChangelog } from "./changelog.js";
import {
  deviceTranscriptionAvailable,
  transcribeDeviceMedia,
  type DeviceTranscriptionInput,
} from "./device-transcription.js";
import {
  testGatewayConnection,
  type ConnectivityReport,
  type TestConnectionInput,
} from "./gateway-connectivity.js";
import {
  getGatewayRuntimeSnapshot,
  nudgeGatewayMonitor,
} from "./gateway-monitor.js";
import {
  redeemGatewayPairing,
  type RedeemGatewayPairingInput,
  type RedeemGatewayPairingResult,
} from "./gateway-pairing.js";
import {
  GatewayError,
  listGateways,
  removeGateway,
  renameGateway,
  updateProfileMetadata,
  type GatewayProfile,
} from "./gateway-store.js";
import {
  listGatewayVaults,
  type ListGatewayVaultsResult,
} from "./gateway-vaults.js";
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
  loadSettings,
  requestLocalGatewayStart,
  saveSettings,
  setActiveGatewayId,
  setActiveVaultId,
  type DesktopSettings,
} from "./settings.js";
import {
  checkForUpdatesManual,
  getUpdateStatus,
  relaunchToUpdate,
} from "./update-watcher.js";

/**
 * Status read for the auto-publish queue (issue #137: there is no
 * queue anymore — every publish is synchronous via PUBLISH IPC). Kept
 * as a stable renderer surface so `builder.ts` doesn't need to change;
 * always returns "not in flight". The `PUBLISH_EVENT` channel is
 * similarly never fired post-#137 — the renderer's onPublishEvent
 * subscription just stays quiet.
 */
type PublishStatus = {
  inFlight: boolean;
  lastError?: string;
  lastPublishedAt?: number;
};
const getPublishStatus = (_id: string): PublishStatus => ({ inFlight: false });

export function registerIpcHandlers(): void {
  // Broadcast helper for "active gateway changed" — fires after any
  // mutation that affects the active gateway's URL/token/identity so
  // the renderer can drop and re-fetch gateway-scoped state.
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

  // Invalidate the renderer's HTTP-client caches after a gateway swap
  // or token rotation. The auth-injector caches an Authorization
  // header per origin; the user-prefs / chat-history clients cache
  // their bearer too. All three need to drop their caches together.
  const invalidateGatewayCaches = async (): Promise<void> => {
    resetAppsStoreAuthCache();
    // Per-app editing sessions are per-gateway (the worktrees live in
    // the previous gateway's git store); forget them so the next edit
    // opens a fresh session on the new active gateway.
    resetAppSessions();
    await refreshAuthInjector();
  };

  // Vault switch is lighter than a gateway swap (issue #289): the base URL +
  // token are unchanged, only the addressed vault. Drop the auth caches so
  // every client re-reads the new `x-centraid-vault` header, and refresh the
  // iframe injector — but KEEP the app-editing sessions. They are keyed by
  // gateway (their worktrees live in THIS gateway's store) and survive a
  // vault flip untouched; that's the keyed-state invariant the switch
  // preserves.
  const invalidateVaultCaches = async (): Promise<void> => {
    resetAppsStoreAuthCache();
    await refreshAuthInjector();
  };

  // Broadcast "the addressed vault changed" so the renderer re-reads its
  // gateway auth (new vault header) and re-renders the active vault's world,
  // without the wholesale wipe a gateway change triggers.
  const broadcastVaultChanged = (next: DesktopSettings): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(Channel.VAULT_CHANGED, vaultChangedPayload(next));
    }
  };

  // ----- Settings -----
  // The bearer token reaches the renderer only through `getGatewayAuth()`
  // (the single bridge crossing post thin-client pivot), so the broad
  // settings payload no longer carries `gatewayToken` — nothing in the
  // renderer reads it off `getSettings()`.
  ipcMain.handle(Channel.SETTINGS_GET, async () => {
    const { gatewayToken: _gatewayToken, ...rest } = await loadSettings();
    return rest;
  });
  ipcMain.handle(
    Channel.SETTINGS_SAVE,
    async (_e, patch: Partial<DesktopSettings>) => {
      const next = await saveSettings(patch);
      // Settings can no longer flip gateway URL/token directly (those
      // live in the gateway store), but the active gateway pointer can
      // change through here — invalidate caches the same way.
      await invalidateGatewayCaches();
      // Alert-threshold/toggle changes ride this surface too — re-broadcast
      // the runtime snapshot now so the Gateway page reflects them instantly.
      nudgeGatewayMonitor();
      // launchAtLogin (issue #351) rides this same generic surface — apply it
      // to the OS immediately rather than waiting for next launch.
      if ("launchAtLogin" in patch) applyLaunchAtLogin(next.launchAtLogin);
      return next;
    }
  );
  ipcMain.handle(Channel.DEVICE_TRANSCRIPT_AVAILABLE, () =>
    deviceTranscriptionAvailable()
  );
  ipcMain.handle(
    Channel.DEVICE_TRANSCRIBE,
    (_e, input: DeviceTranscriptionInput) => transcribeDeviceMedia(input)
  );

  // ----- Gateways (issue #109) -----
  // The local gateway is always present and can't be removed; remote
  // gateways are added/removed/renamed through the Settings → Gateways
  // panel. Tokens never cross the bridge — `add` accepts plaintext
  // and immediately persists to keychain via gateway-secrets.
  ipcMain.handle(
    Channel.GATEWAYS_LIST,
    async (): Promise<GatewayProfile[]> => listGateways()
  );

  // Issue #505 phase 7 retired the renderer's manual "add gateway by URL +
  // token" IPC — every gateway is now added through the pairing ceremony
  // (`redeemGatewayPairing`), which calls `addGateway` in-process itself.

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
      // Metadata-only change — no URL/token flip — but the renderer's
      // switcher cache wants to refresh, so emit on the bus.
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
      } catch (err) {
        if (err instanceof GatewayError && err.code === "local_not_removable") {
          throw new Error(err.message, { cause: err });
        }
        throw err;
      }
      // If the active gateway was removed, fall back to local. Either
      // way the caches need to drop so the renderer's HTTP clients
      // re-resolve via the (possibly new) active gateway. Sessions
      // are disposed too — they may have been rooted in the removed
      // gateway's workspace, and even when they weren't, the renderer
      // will bounce home on the broadcast so any UI tying back to them
      // is gone anyway.
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
      // Label-only change — no token/URL flip — but the renderer's
      // switcher label cache wants to refresh, so emit on the bus.
      const next = await loadSettings();
      broadcastGatewayChanged(next);
      return updated;
    }
  );

  ipcMain.handle(
    Channel.GATEWAYS_SET_ACTIVE,
    async (_e, input: { id: string }): Promise<DesktopSettings> => {
      const next = await setActiveGatewayId(input.id);
      // Tear down HTTP servers for any local gateways that aren't the
      // new active one. OS-scheduled automations are unaffected — they
      // shell the CLI against per-gateway DB paths and don't depend on
      // the runtime being up. For multi-local installs this keeps just
      // one in-process server alive at a time; for the common
      // local-then-remote case it shuts the local server down entirely.
      const { shutdownAllLocalGatewaysExcept } =
        await import("./local-gateway.js");
      await shutdownAllLocalGatewaysExcept(
        next.activeGatewayKind === "local" ? next.activeGatewayId : undefined
      );
      // Tear down iroh proxies for every gateway but the new active one
      // (issue #289) — a dormant QUIC dialer per switch would accumulate.
      const { closeAllIrohDialersExcept } = await import("./iroh-dialer.js");
      await closeAllIrohDialersExcept(
        next.activeGatewayKind === "remote" ? next.activeGatewayId : undefined
      );
      await invalidateGatewayCaches();
      broadcastGatewayChanged(next);
      // Reset runtime tracking against the new gateway immediately (the
      // monitor re-keys on activeGatewayId per tick; don't wait one out).
      nudgeGatewayMonitor();
      return next;
    }
  );

  // Redeem a pairing ticket (issue #376): decode + dial (iroh) or POST
  // (http), add-or-reuse the gateway profile, and flip BOTH the active
  // gateway and the active vault on it (a pairing ticket enrolls into
  // exactly one vault). On success this runs the same
  // teardown/cache-invalidation/broadcast sequence `GATEWAYS_SET_ACTIVE`
  // does — `gateway-pairing.ts` stays free of `BrowserWindow` so it unit-tests
  // as a plain async function.
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

  // Read a gateway's vaults WITHOUT switching to it (issue #376) — the flat
  // (gateway, vault) switcher's preview. Pure read; no cache invalidation or
  // broadcast, since nothing about the active gateway/vault changed.
  ipcMain.handle(
    Channel.GATEWAYS_LIST_VAULTS,
    async (
      _e,
      input: { gatewayId: string }
    ): Promise<ListGatewayVaultsResult> => listGatewayVaults(input.gatewayId)
  );

  // ConnectFlow "handshake ladder" (issue #382): a pure read, no cache
  // invalidation or broadcast — never throws, every failure is a failed
  // stage in the returned report.
  ipcMain.handle(
    Channel.GATEWAY_TEST_CONNECTION,
    async (_e, input: TestConnectionInput): Promise<ConnectivityReport> =>
      testGatewayConnection(input)
  );

  // Vault switch (issue #289): a pure client-side pointer flip on the active
  // gateway. No server call, no re-root, no session/iframe teardown — only
  // the auth cache drops so the next request carries the new
  // `x-centraid-vault` header. The renderer keeps its per-(gateway,vault)
  // state buckets and re-renders on the VAULT_CHANGED broadcast.
  ipcMain.handle(
    Channel.VAULTS_SET_ACTIVE,
    async (_e, input: { vaultId?: string }): Promise<DesktopSettings> => {
      const next = await setActiveVaultId(input.vaultId);
      await invalidateVaultCaches();
      broadcastVaultChanged(next);
      return next;
    }
  );

  // Vault create/delete run on the LOCAL gateway only: the desktop is the
  // landlord for its own in-process gateway, and a remote gateway's vault
  // lifecycle is a host-side admin act. Issue #603 deleted the SSH-routed
  // remote create, so both verbs share this one guard again.
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
      // Never delete the vault the client is currently addressing — clear
      // the pointer first so the next request falls back to the default.
      let next: DesktopSettings | undefined;
      if (settings.activeVaultId === input.vaultId) {
        next = await setActiveVaultId(undefined);
        await invalidateVaultCaches();
      }
      const { deleteLocalVault } = await import("./local-gateway.js");
      await deleteLocalVault(gatewayId, input.vaultId, input.name);
      // Every other vault-mutating handler (create/switch/pair/ssh-connect)
      // broadcasts VAULT_CHANGED so the renderer's active-vault state
      // (sidebar head, switcher, Settings -> Space) re-reads itself. This
      // one didn't — deleting the ACTIVE vault left the shell showing the
      // just-deleted vault's name until some unrelated event happened to
      // refresh it (found via live E2E, issue #382).
      if (next) broadcastVaultChanged(next);
      return { deleted: true };
    }
  );

  // Notify-only: the renderer calls this right after a metadata-only
  // `updateVault()` HTTP call succeeds (rename/retheme via Settings ->
  // Space or the switcher's "New space" edit path) so every window's
  // sidebar head re-reads the vault list immediately. Broadcasts on the
  // SEPARATE VAULT_METADATA_PUSH channel, not VAULT_CHANGED — no addressing
  // changed here, so this must not trigger `reScope`'s navigate-Home.
  ipcMain.handle(Channel.VAULT_METADATA_CHANGED, (): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(Channel.VAULT_METADATA_PUSH);
    }
  });

  // ----- User identity + prefs (gateway-backed) -----
  // USER_ID_GET / USER_PREFS_GET / USER_PREFS_SAVE moved to the renderer's
  // direct HTTP client (renderer/gateway-client.ts) under the thin-client
  // pivot.
  //
  // Coding-agent detection + the custom OpenAI-compatible endpoint config
  // also left the main process: the gateway is colocated with the runner, so
  // it owns both the credential probe (`GET /centraid/_agents/status`) and
  // the runner preflight (`GET /centraid/_turn/runner-status`). The renderer
  // reads them over HTTP via `renderer/gateway-client-conversation.ts` — a remote
  // gateway reports its own host's agents.

  // ----- Apps (issue #137: git-store backend; #141: thin client) -----
  // App lifecycle (create/files/write/delete/update-meta) + publish moved to
  // the renderer's direct HTTP client (renderer/gateway-client.ts) under the
  // thin-client pivot: the renderer opens its own editing session per app
  // (same `desktop-<id>` id the local agent uses, so they share one draft)
  // and the gateway owns scaffold/clone/meta/publish. APPS_OPEN stays on
  // IPC — a deliberately LOCAL-ONLY reveal-in-Finder that needs the on-disk
  // session worktree. The preview iframe now points at the gateway draft URL
  // (`/centraid/_draft/<sessionId>/<id>/`, resolved renderer-side via
  // `draftPreviewUrl`), so no APPS_PREVIEW_URL handler is needed.

  ipcMain.handle(Channel.APPS_OPEN, async (_e, input: { id: string }) => {
    // Reveal-in-Finder: opens the app's on-disk code — the live published
    // dir when available, else its editing-session worktree. One of the two
    // deliberately LOCAL-ONLY handlers (issue #141) — a remote gateway
    // exposes no worktree over the filesystem. The renderer hides this for
    // remote; `resolveAppRevealDir` (via `assertActiveGatewayLocal`) is the
    // backstop and throws a clear error if it's ever reached remotely.
    const dir = await resolveAppRevealDir(input.id);
    // `shell.openPath` reports failure by RESOLVING with a non-empty error
    // string (it doesn't reject), so the previous `await` swallowed every
    // failure and the handler always claimed success. Surface it instead, so
    // the renderer's catch shows a real toast.
    const openErr = await shell.openPath(dir);
    if (openErr) throw new Error(`Could not open ${dir}: ${openErr}`);
    return { ok: true };
  });

  // APPS_DELETE + APPS_UPDATE_META moved to the renderer's direct
  // HTTP client (renderer/gateway-client.ts): delete is a `DELETE /_apps/<id>`
  // + session close; meta is a `POST /_apps/<id>/meta` the gateway stages +
  // publishes.

  // Snapshot of the auto-publish queue for app `id`. Cheap; safe to
  // poll from the renderer if a toast wants the latest error string.
  ipcMain.handle(
    Channel.PUBLISH_STATUS,
    async (_e, input: { id: string }): Promise<PublishStatus> =>
      getPublishStatus(input.id)
  );

  // ----- Publish + versions (issue #137; #141: thin client) -----
  // PUBLISH moved to the renderer's direct HTTP client
  // (renderer/gateway-client.ts): the renderer holds the editing session and
  // POSTs `…/publish` directly. VERSIONS_LIST / VERSIONS_ACTIVATE moved there
  // too (pure git-store tag reads + a forward-only rollback POST).

  // Thin-client token bridge: resolve the active gateway's base URL +
  // bearer token for the renderer's direct HTTP client. The token lives
  // in keychain-backed settings; this is the only path it crosses to the
  // renderer, and it's re-fetched whenever the active gateway flips.
  // Latest gateway-runtime snapshot (heartbeat status + sample strip +
  // outage log + alert config). Pushed on every poll via
  // GATEWAY_RUNTIME_EVENT; this read covers the first paint.
  ipcMain.handle(Channel.GATEWAY_RUNTIME_GET, async () =>
    getGatewayRuntimeSnapshot()
  );

  // Manual restart of the embedded LOCAL gateway (issue #351): refused for
  // a remote gateway (nothing here to restart — that's the server's job).
  // `restartLocalGateway` always mints a fresh per-launch bearer token
  // (same as first boot, since no `token` option is passed to `serve()`),
  // so on success this invalidates the renderer's HTTP-client auth caches
  // and re-broadcasts the active gateway — the same plumbing a gateway
  // switch runs, just without an id change.
  ipcMain.handle(
    Channel.GATEWAY_RESTART,
    async (): Promise<{ ok: boolean; error?: string }> => {
      const settings = await loadSettings();
      if (settings.activeGatewayKind !== "local") {
        return { ok: false, error: "remote gateways restart server-side" };
      }
      try {
        // An explicit restart is a user act, so it lifts the first-run
        // keychain deferral the same way the chooser's local-connect does.
        requestLocalGatewayStart();
        const { restartLocalGateway } = await import("./local-gateway.js");
        await restartLocalGateway(settings.activeGatewayId);
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      await invalidateGatewayCaches();
      const next = await loadSettings();
      broadcastGatewayChanged(next);
      nudgeGatewayMonitor();
      return { ok: true };
    }
  );

  // Fetch the active gateway's diagnostics bundle and save it via a native
  // dialog (issue #351). Pure orchestration lives in gateway-ops-core.ts;
  // gateway-ops.ts wires in the real dialog/fs/settings.
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
        // The vault the renderer addresses on this gateway (#289) — sent as
        // the `x-centraid-vault` header. Undefined = let the gateway pick.
        ...(settings.activeVaultId === undefined
          ? {}
          : { vaultId: settings.activeVaultId }),
      };
    }
  );

  // VERSIONS_LIST / VERSIONS_ACTIVATE moved to the renderer's direct HTTP
  // client (`renderer/gateway-client.ts`) under the thin-client pivot —
  // pure git-store tag reads + a forward-only rollback POST, no main-side
  // state. APP_LIVE_URL / APP_SCHEMA / APP_TABLE_ROWS / APP_QUERY /
  // APP_LOGS / APPS_DEREGISTER moved there too.

  // ----- Phone link (issue #263) -----
  // The tunnel endpoint + device allowlist live in main (they hold the
  // persistent endpoint key and must outlive renderer reloads); the
  // Settings → Phone panel drives them through these four handlers and the
  // PHONE_PAIRED broadcast (fired by phone-link.ts when a pairing lands).
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

  // ----- Relaunch to update -----
  // Status snapshot for windows that mount after the UPDATE_AVAILABLE
  // broadcast; relaunch restarts the process so it loads the new dist.
  ipcMain.handle(Channel.UPDATE_STATUS, async () => getUpdateStatus());
  // I6 manual check — always admits candidates when feed reports one.
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

  // ----- Keychain pre-write note (issue #603) -----
  // Answers "will starting the local gateway pop an OS credential prompt?"
  // so the first-run chooser can warn BEFORE the dialog appears instead of
  // leaving the user to guess what asked for their password. Policy lives in
  // the pure `keychainPromptExpected`; this handler only reads the live host.
  ipcMain.handle(Channel.KEYCHAIN_PROMPT_EXPECTED, (): boolean =>
    keychainPromptExpected({
      platform: process.platform,
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      packaged: app.isPackaged,
    })
  );

  // ----- "What's new" changelog -----
  ipcMain.handle(Channel.CHANGELOG_GET, async () => getChangelog());

  // ----- Templates -----
  // TEMPLATES_LIST + TEMPLATES_CLONE moved to the renderer's direct HTTP
  // client (renderer/gateway-client.ts) under the thin-client pivot — the
  // gateway owns the catalog (`GET /centraid/_templates`) and the clone
  // orchestration (`POST /centraid/_apps/_clone`: scaffold + webhook mint +
  // stage + publish). The remote gateway never needs the desktop catalog.

  // ----- Automations (issue #98; #141: thin client) -----
  // Automation create/enable/delete + the read/run/analytics surface moved
  // to the renderer's direct HTTP client (renderer/gateway-client.ts): the
  // gateway owns scaffold + webhook mint + stage + publish
  // (`POST /centraid/_automations`, `…/set-enabled`, `DELETE …`). The gateway
  // owns the materialized `main` (code), the per-app `runtime.sqlite`
  // ledgers, and the central analytics DB.

  // The run feed / single-run / node-timeline / pin-run reads and
  // INSIGHTS_SUMMARY moved to the renderer's direct HTTP client
  // (renderer/gateway-client.ts) under the thin-client pivot — they were
  // pure proxies over the gateway's `/centraid/_automations` +
  // `/centraid/_insights` routes with no main-side state.
}
