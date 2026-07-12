// governance: allow-repo-hygiene file-size-limit ipc-hub pending split per-feature handler modules (agent, chat, apps, provider) once the surface stabilizes
import { ipcMain, BrowserWindow, shell } from 'electron';
import {
  loadSettings,
  saveSettings,
  setActiveGatewayId,
  setActiveVaultId,
  type DesktopSettings,
} from './settings.js';
import {
  addGateway,
  GatewayError,
  listGateways,
  removeGateway,
  renameGateway,
  updateGatewayToken,
  updateProfileMetadata,
  type GatewayProfile,
} from './gateway-store.js';
import { getGatewayRuntimeSnapshot, nudgeGatewayMonitor } from './gateway-monitor.js';
import { applyLaunchAtLogin } from './login-item.js';
import { refreshAuthInjector } from './auth-injector.js';
import { resetConversationHistoryAuthCache } from './conversation-history-client.js';
import { resetUserPrefsAuthCache } from './user-prefs-client.js';
import { resetAppsStoreAuthCache } from './apps-store-client.js';
import { resolveAppRevealDir, resetAppSessions } from './app-sessions.js';
import {
  beginPhonePairing,
  cancelPhonePairing,
  phoneLinkStatus,
  revokePhoneDevice,
} from './phone-link.js';
import { getUpdateStatus, relaunchToUpdate } from './update-watcher.js';
import { getChangelog } from './changelog.js';
import {
  redeemGatewayPairing,
  type RedeemGatewayPairingInput,
  type RedeemGatewayPairingResult,
} from './gateway-pairing.js';
import { listGatewayVaults, type ListGatewayVaultsResult } from './gateway-vaults.js';
import {
  testGatewayConnection,
  type ConnectivityReport,
  type TestConnectionInput,
} from './gateway-connectivity.js';
import {
  sshConnectGateway,
  sshEnrollIntoVault,
  type SshConnectResult,
} from './gateway-ssh-connect.js';
import { sshVaultCreate } from './ssh-host.js';

/**
 * Status read for the auto-publish queue (issue #137: there is no
 * queue anymore — every publish is synchronous via PUBLISH IPC). Kept
 * as a stable renderer surface so `builder.ts` doesn't need to change;
 * always returns "not in flight". The `PUBLISH_EVENT` channel is
 * similarly never fired post-#137 — the renderer's onPublishEvent
 * subscription just stays quiet.
 */
type PublishStatus = { inFlight: boolean; lastError?: string; lastPublishedAt?: number };
const getPublishStatus = (_id: string): PublishStatus => ({ inFlight: false });

/**
 * IPC channel names. Keep in sync with `preload.ts` (contextBridge surface)
 * and the renderer-side typings in `renderer/centraid-api.d.ts`.
 */
export const Channel = {
  SETTINGS_GET: 'centraid:settings:get',
  SETTINGS_SAVE: 'centraid:settings:save',

  // App create/files/write/delete/update-meta + publish moved to the
  // renderer's direct HTTP client (renderer/gateway-client.ts). The preview
  // iframe now points at the gateway draft URL (Phase 4), so only the
  // local-only reveal-in-Finder stays on IPC.
  APPS_OPEN: 'centraid:apps:open',

  // The in-process AGENT_* builder retired with the unified chat (issue
  // #141, Phase 3): the builder now streams the gateway's `/centraid/<id>/_turn`
  // SSE directly, so the agent runs server-side in the draft worktree.

  // PUBLISH + the app read surface (APP_LIVE_URL / APP_SCHEMA /
  // APP_TABLE_ROWS / APP_QUERY / APP_LOGS / APPS_DEREGISTER / VERSIONS_LIST /
  // VERSIONS_ACTIVATE) are gone — the renderer calls these gateway routes
  // directly (thin-client pivot; see renderer/gateway-client.ts).

  /** Status read for the auto-publish queue (renderer toast / debug). */
  PUBLISH_STATUS: 'centraid:publish:status',

  // Gateway lifecycle (issue #109). The primordial local gateway
  // ('local') is special-cased (always present, can't be removed).
  // Remote gateways and additional local gateways (workspaces) get
  // UUID ids and can be renamed/removed freely.
  GATEWAYS_LIST: 'centraid:gateways:list',
  GATEWAYS_ADD: 'centraid:gateways:add',
  GATEWAYS_REMOVE: 'centraid:gateways:remove',
  GATEWAYS_RENAME: 'centraid:gateways:rename',
  GATEWAYS_UPDATE_METADATA: 'centraid:gateways:update-metadata',
  GATEWAYS_UPDATE_TOKEN: 'centraid:gateways:update-token',
  GATEWAYS_SET_ACTIVE: 'centraid:gateways:set-active',
  GATEWAY_CHANGED: 'centraid:gateways:changed',
  // Pairing-ticket redemption (issue #376): the desktop half of "Add gateway
  // by pairing code" — decode + dial/POST, add-or-reuse the profile, flip
  // active gateway + active vault. See `gateway-pairing.ts`.
  GATEWAY_PAIR_REDEEM: 'centraid:gateways:pair-redeem',
  // Read a gateway's vault list WITHOUT switching to it (issue #376) — the
  // flat (gateway, vault) switcher preview. See `gateway-vaults.ts`.
  GATEWAYS_LIST_VAULTS: 'centraid:gateways:list-vaults',
  // ConnectFlow "handshake ladder" (issue #382): staged connectivity check
  // for a not-yet-added (or already-known) gateway, across every method —
  // url/ticket/ssh/gateway. See `gateway-connectivity.ts`.
  GATEWAY_TEST_CONNECTION: 'centraid:gateways:test-connection',
  // ConnectFlow "Over SSH" commit step (issue #382): (optional) create a
  // vault remotely, mint+redeem a pairing ticket, persist the ssh block on
  // the resulting profile. See `gateway-ssh-connect.ts`.
  GATEWAY_SSH_CONNECT: 'centraid:gateways:ssh-connect',
  // Vault addressing (issue #289): the active vault is client-side state,
  // keyed by gateway. Switching is a pure pointer flip — no server call —
  // that changes the `x-centraid-vault` header the renderer sends. The
  // VAULT_CHANGED broadcast tells the renderer to re-read + re-render
  // WITHOUT the wholesale cache wipe a gateway switch triggers.
  VAULTS_SET_ACTIVE: 'centraid:vaults:set-active',
  VAULT_CHANGED: 'centraid:vaults:changed',
  // Vault lifecycle is an ADMIN act (issue #289): for a REMOTE gateway it's
  // the server CLI over SSH (no client surface). For the desktop's own
  // in-process LOCAL gateway the desktop IS the landlord, so these run
  // against the embedded registry directly.
  VAULTS_CREATE: 'centraid:vaults:create',
  VAULTS_DELETE: 'centraid:vaults:delete',
  // Vault metadata (name/color/icon/blurb) rides a direct renderer->gateway
  // HTTP `updateVault()` call (`spaceModals.ts`'s `saveSpace`), not IPC — so
  // unlike create/switch/delete it never fired any broadcast, leaving the
  // sidebar head showing the stale name/color after a Settings -> Space
  // save until an unrelated event refreshed it (found via live E2E, #382
  // follow-up). VAULT_METADATA_CHANGED is the renderer->main "please notify"
  // invoke, called right after `updateVault()` succeeds. It deliberately
  // does NOT reuse VAULT_CHANGED's broadcast: App.tsx's `reScope` treats
  // every VAULT_CHANGED as "the ADDRESSED vault changed" and navigates Home
  // + wipes gateway-scoped state — correct for a real switch, wrong for a
  // same-vault rename (confirmed live: it silently kicked the user off the
  // Settings -> Space page mid-edit). VAULT_METADATA_PUSH is the resulting
  // main->renderer broadcast; only `useActiveVault`'s lightweight "re-read
  // the vault list" listens to it, not `reScope`.
  VAULT_METADATA_CHANGED: 'centraid:vaults:metadata-changed',
  VAULT_METADATA_PUSH: 'centraid:vaults:metadata-push',
  // Thin-client: hands the renderer the active gateway's HTTP base URL +
  // bearer token so it can call the runtime/data plane directly. Main
  // still owns where the token lives (keychain-backed settings); this is
  // the single point where it crosses to the renderer.
  GATEWAY_AUTH_GET: 'centraid:gateways:auth',

  // Gateway runtime watch (gateway-monitor.ts): main polls the active
  // gateway's `/_gateway/health` heartbeat (falling back to `/_gateway/info`
  // for older gateways), keeps the per-launch sample/outage history, and
  // fires the OS down-alert. GET serves the latest snapshot; EVENT pushes
  // one per poll so the Gateway page live-updates.
  GATEWAY_RUNTIME_GET: 'centraid:gateway-runtime:get',
  GATEWAY_RUNTIME_EVENT: 'centraid:gateway-runtime:event',
  // Gateway ops (issue #351): manual restart of the local embedded gateway
  // + save-dialog export of the gateway's diagnostics bundle.
  GATEWAY_RESTART: 'centraid:gateway-runtime:restart',
  GATEWAY_DIAGNOSTICS_EXPORT: 'centraid:gateway-runtime:export-diagnostics',

  // Phone link (issue #263): the iroh tunnel that lets the mobile app reach
  // this desktop's loopback gateway from anywhere. Pairing is a one-time
  // QR code; paired devices are EndpointId-keyed and revocable.
  PHONE_STATUS: 'centraid:phone:status',
  PHONE_BEGIN_PAIRING: 'centraid:phone:begin-pairing',
  PHONE_CANCEL_PAIRING: 'centraid:phone:cancel-pairing',
  PHONE_REVOKE: 'centraid:phone:revoke',
  PHONE_PAIRED: 'centraid:phone:paired',

  // Relaunch-to-update: the dist watcher (main/update-watcher.ts) notices a
  // new build on disk and broadcasts UPDATE_AVAILABLE (channel string owned
  // by that module); the sidebar pill reads the snapshot and triggers the
  // relaunch through these two.
  UPDATE_STATUS: 'centraid:update:status',
  UPDATE_RELAUNCH: 'centraid:update:relaunch',

  // "What's new" changelog: main fetches the project's GitHub Releases (there
  // is no bundled CHANGELOG — each release's notes are the changelog) and
  // hands the renderer modal the running version + the release list. Cached in
  // main so reopening / the auto-open probe doesn't hammer GitHub's rate limit.
  CHANGELOG_GET: 'centraid:changelog:get',

  // TEMPLATES_LIST + TEMPLATES_CLONE moved to the renderer's direct HTTP
  // client — the gateway owns the catalog + clone (`POST /_apps/_clone`).

  // Gateway-side user identity + global preferences (theme, density, accent…)
  // moved to the renderer's direct HTTP client (renderer/gateway-client.ts)
  // under the thin-client pivot — pure `/_centraid-user/*` reads/writes.
  //
  // Coding-agent detection, the runner preflight, and the custom
  // OpenAI-compatible endpoint config + key all moved to the gateway (it's
  // colocated with the runner): the renderer reads `/centraid/_agents/status`
  // and `/centraid/_turn/runner-status` over HTTP.

  // Automations (issue #98): the full surface — create/enable/delete +
  // read/run/analytics + INSIGHTS_SUMMARY — moved to the renderer's direct
  // HTTP client (renderer/gateway-client.ts) under the thin-client pivot;
  // the gateway owns scaffold + webhook mint + stage + publish.
} as const;

export function registerIpcHandlers(): void {
  // Broadcast helper for "active gateway changed" — fires after any
  // mutation that affects the active gateway's URL/token/identity so
  // the renderer can drop and re-fetch gateway-scoped state.
  const broadcastGatewayChanged = (next: DesktopSettings): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(Channel.GATEWAY_CHANGED, {
        activeGatewayId: next.activeGatewayId,
        activeGatewayKind: next.activeGatewayKind,
        activeGatewayLabel: next.activeGatewayLabel,
        activeProfileDisplayName: next.activeProfileDisplayName,
        activeProfileAvatarColor: next.activeProfileAvatarColor,
      });
    }
  };

  // Invalidate the renderer's HTTP-client caches after a gateway swap
  // or token rotation. The auth-injector caches an Authorization
  // header per origin; the user-prefs / chat-history clients cache
  // their bearer too. All three need to drop their caches together.
  const invalidateGatewayCaches = async (): Promise<void> => {
    resetConversationHistoryAuthCache();
    resetUserPrefsAuthCache();
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
    resetConversationHistoryAuthCache();
    resetUserPrefsAuthCache();
    resetAppsStoreAuthCache();
    await refreshAuthInjector();
  };

  // Broadcast "the addressed vault changed" so the renderer re-reads its
  // gateway auth (new vault header) and re-renders the active vault's world,
  // without the wholesale wipe a gateway change triggers.
  const broadcastVaultChanged = (next: DesktopSettings): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(Channel.VAULT_CHANGED, {
        activeGatewayId: next.activeGatewayId,
        ...(next.activeVaultId !== undefined ? { activeVaultId: next.activeVaultId } : {}),
      });
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
  ipcMain.handle(Channel.SETTINGS_SAVE, async (_e, patch: Partial<DesktopSettings>) => {
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
    if ('launchAtLogin' in patch) applyLaunchAtLogin(next.launchAtLogin);
    return next;
  });

  // ----- Gateways (issue #109) -----
  // The local gateway is always present and can't be removed; remote
  // gateways are added/removed/renamed through the Settings → Gateways
  // panel. Tokens never cross the bridge — `add` accepts plaintext
  // and immediately persists to keychain via gateway-secrets.
  ipcMain.handle(Channel.GATEWAYS_LIST, async (): Promise<GatewayProfile[]> => listGateways());

  ipcMain.handle(
    Channel.GATEWAYS_ADD,
    async (
      _e,
      input: {
        label: string;
        /** `direct` transport: an https/http URL (guardrail rejects public http). */
        url?: string;
        /** `iroh` transport: an EndpointTicket redeemed from a pairing ticket. */
        endpointTicket?: string;
        endpointId?: string;
        token: string;
        displayName?: string;
        avatarColor?: string;
      },
    ): Promise<GatewayProfile> => addGateway(input),
  );

  ipcMain.handle(
    Channel.GATEWAYS_UPDATE_METADATA,
    async (
      _e,
      input: { id: string; displayName?: string; avatarColor?: string },
    ): Promise<GatewayProfile> => {
      const updated = await updateProfileMetadata(input.id, {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.avatarColor !== undefined ? { avatarColor: input.avatarColor } : {}),
      });
      // Metadata-only change — no URL/token flip — but the renderer's
      // switcher cache wants to refresh, so emit on the bus.
      const next = await loadSettings();
      broadcastGatewayChanged(next);
      return updated;
    },
  );

  ipcMain.handle(
    Channel.GATEWAYS_REMOVE,
    async (_e, input: { id: string }): Promise<{ activeGatewayId: string }> => {
      try {
        await removeGateway(input.id);
      } catch (err) {
        if (err instanceof GatewayError && err.code === 'local_not_removable') {
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
        next = await setActiveGatewayId('local');
      }
      await invalidateGatewayCaches();
      broadcastGatewayChanged(next);
      return { activeGatewayId: next.activeGatewayId };
    },
  );

  ipcMain.handle(
    Channel.GATEWAYS_RENAME,
    async (_e, input: { id: string; label: string }): Promise<GatewayProfile> => {
      const updated = await renameGateway(input.id, input.label);
      // Label-only change — no token/URL flip — but the renderer's
      // switcher label cache wants to refresh, so emit on the bus.
      const next = await loadSettings();
      broadcastGatewayChanged(next);
      return updated;
    },
  );

  // Rotate the keychain-stored bearer token for a remote gateway.
  // Plaintext crosses the bridge exactly once on this call (same shape
  // as `add`) and is immediately persisted via gateway-secrets. Pass
  // an empty string to clear. No-op for the local gateway (its token
  // is minted per launch by the in-process runtime). When the rotated
  // profile is the active one, drop HTTP-client auth caches so the
  // next request re-reads the new token from the keychain.
  ipcMain.handle(
    Channel.GATEWAYS_UPDATE_TOKEN,
    async (_e, input: { id: string; token: string }): Promise<{ ok: true }> => {
      await updateGatewayToken(input.id, input.token);
      const current = await loadSettings();
      if (current.activeGatewayId === input.id) {
        await invalidateGatewayCaches();
        broadcastGatewayChanged(current);
      }
      return { ok: true };
    },
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
      const { shutdownAllLocalGatewaysExcept } = await import('./local-gateway.js');
      await shutdownAllLocalGatewaysExcept(
        next.activeGatewayKind === 'local' ? next.activeGatewayId : undefined,
      );
      // Tear down iroh proxies for every gateway but the new active one
      // (issue #289) — a dormant QUIC dialer per switch would accumulate.
      const { closeAllIrohDialersExcept } = await import('./iroh-dialer.js');
      await closeAllIrohDialersExcept(
        next.activeGatewayKind === 'remote' ? next.activeGatewayId : undefined,
      );
      await invalidateGatewayCaches();
      broadcastGatewayChanged(next);
      // Reset runtime tracking against the new gateway immediately (the
      // monitor re-keys on activeGatewayId per tick; don't wait one out).
      nudgeGatewayMonitor();
      return next;
    },
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
    async (_e, input: RedeemGatewayPairingInput): Promise<RedeemGatewayPairingResult> => {
      const result = await redeemGatewayPairing(input);
      if (result.ok) {
        const next = await loadSettings();
        const { shutdownAllLocalGatewaysExcept } = await import('./local-gateway.js');
        await shutdownAllLocalGatewaysExcept(
          next.activeGatewayKind === 'local' ? next.activeGatewayId : undefined,
        );
        const { closeAllIrohDialersExcept } = await import('./iroh-dialer.js');
        await closeAllIrohDialersExcept(
          next.activeGatewayKind === 'remote' ? next.activeGatewayId : undefined,
        );
        await invalidateGatewayCaches();
        broadcastGatewayChanged(next);
        broadcastVaultChanged(next);
        nudgeGatewayMonitor();
      }
      return result;
    },
  );

  // Read a gateway's vaults WITHOUT switching to it (issue #376) — the flat
  // (gateway, vault) switcher's preview. Pure read; no cache invalidation or
  // broadcast, since nothing about the active gateway/vault changed.
  ipcMain.handle(
    Channel.GATEWAYS_LIST_VAULTS,
    async (_e, input: { gatewayId: string }): Promise<ListGatewayVaultsResult> =>
      listGatewayVaults(input.gatewayId),
  );

  // ConnectFlow "handshake ladder" (issue #382): a pure read, no cache
  // invalidation or broadcast — never throws, every failure is a failed
  // stage in the returned report.
  ipcMain.handle(
    Channel.GATEWAY_TEST_CONNECTION,
    async (_e, input: TestConnectionInput): Promise<ConnectivityReport> =>
      testGatewayConnection(input),
  );

  // ConnectFlow "Over SSH" commit (issue #382): on success this runs the
  // same teardown/cache-invalidation/broadcast sequence GATEWAY_PAIR_REDEEM
  // does, since `sshConnectGateway` ends with the same `redeemGatewayPairing`
  // call under the hood (active gateway + vault both flip).
  ipcMain.handle(
    Channel.GATEWAY_SSH_CONNECT,
    async (
      _e,
      input: {
        destination: string;
        dataDir?: string;
        label?: string;
        vault: { kind: 'existing'; vaultId: string } | { kind: 'create'; name: string };
      },
    ): Promise<SshConnectResult> => {
      const result = await sshConnectGateway(input);
      if (result.ok) {
        const next = await loadSettings();
        const { shutdownAllLocalGatewaysExcept } = await import('./local-gateway.js');
        await shutdownAllLocalGatewaysExcept(
          next.activeGatewayKind === 'local' ? next.activeGatewayId : undefined,
        );
        const { closeAllIrohDialersExcept } = await import('./iroh-dialer.js');
        await closeAllIrohDialersExcept(
          next.activeGatewayKind === 'remote' ? next.activeGatewayId : undefined,
        );
        await invalidateGatewayCaches();
        broadcastGatewayChanged(next);
        broadcastVaultChanged(next);
        nudgeGatewayMonitor();
      }
      return result;
    },
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
    },
  );

  // Vault create/delete on the LOCAL gateway only (issue #289): the desktop
  // is the landlord for its own in-process gateway. A remote gateway's vault
  // lifecycle is the server CLI's job (admin plane over SSH) — refuse here
  // with a message pointing at it. Still used by VAULTS_DELETE unchanged
  // (see its comment below for why delete didn't get the ssh-routing
  // VAULTS_CREATE got).
  const assertLocalAdmin = async (): Promise<string> => {
    const settings = await loadSettings();
    if (settings.activeGatewayKind !== 'local') {
      throw new Error(
        'Vault create/delete on a remote gateway is a server-side admin act — ' +
          'run `centraid-gateway vault …` on that box over SSH.',
      );
    }
    return settings.activeGatewayId;
  };

  // Where VAULTS_CREATE routes (issue #382): local stays the desktop's own
  // in-process create; a remote gateway routes over SSH when its profile
  // carries an `ssh` block (set by GATEWAY_SSH_CONNECT, or a prior ssh
  // create); a plain remote gateway (no ssh block) is still refused with
  // the same message `assertLocalAdmin` throws.
  const resolveVaultCreateRoute = async (): Promise<
    | { mode: 'local'; gatewayId: string }
    | { mode: 'ssh'; gatewayId: string; profile: GatewayProfile['ssh'] }
  > => {
    const settings = await loadSettings();
    if (settings.activeGatewayKind === 'local') {
      return { mode: 'local', gatewayId: settings.activeGatewayId };
    }
    const profiles = await listGateways();
    const active = profiles.find((p) => p.id === settings.activeGatewayId);
    if (active?.ssh) return { mode: 'ssh', gatewayId: active.id, profile: active.ssh };
    throw new Error(
      'Vault create/delete on a remote gateway is a server-side admin act — ' +
        'run `centraid-gateway vault …` on that box over SSH.',
    );
  };

  ipcMain.handle(
    Channel.VAULTS_CREATE,
    async (_e, input: { name?: string }): Promise<{ vaultId: string }> => {
      const route = await resolveVaultCreateRoute();
      if (route.mode === 'local') {
        const { createLocalVault } = await import('./local-gateway.js');
        return createLocalVault(route.gatewayId, input.name);
      }
      // ssh-routed (issue #382): create the vault remotely, then enroll THIS
      // device into it via the exact same pair+redeem helper
      // GATEWAY_SSH_CONNECT uses. Unlike the local path, this DOES flip the
      // active gateway+vault — enrollment (via a pairing ticket redemption)
      // is how a device gains access to a remote vault at all, so
      // `redeemGatewayPairing`'s atomic "enroll + activate" is the correct
      // outcome here, not an accidental side effect. The switcher/renderer
      // should treat a ssh-routed create like a combined create+switch.
      const profile = route.profile as NonNullable<GatewayProfile['ssh']>;
      const created = await sshVaultCreate(profile, input.name);
      if (!created.ok) throw new Error(created.message);
      const enrolled = await sshEnrollIntoVault(profile, created.value.vaultId, undefined);
      if (!enrolled.ok) throw new Error(enrolled.message);
      const next = await loadSettings();
      const { shutdownAllLocalGatewaysExcept } = await import('./local-gateway.js');
      await shutdownAllLocalGatewaysExcept(
        next.activeGatewayKind === 'local' ? next.activeGatewayId : undefined,
      );
      const { closeAllIrohDialersExcept } = await import('./iroh-dialer.js');
      await closeAllIrohDialersExcept(
        next.activeGatewayKind === 'remote' ? next.activeGatewayId : undefined,
      );
      await invalidateGatewayCaches();
      broadcastGatewayChanged(next);
      broadcastVaultChanged(next);
      nudgeGatewayMonitor();
      return { vaultId: enrolled.vaultId };
    },
  );

  // VAULTS_DELETE stays local-only (issue #382 scope decision): a
  // symmetric ssh-routed delete would need `vault delete --json` on the
  // remote CLI first (today only `pair`/`vault list`/`vault create` got
  // `--json`, see `packages/gateway/src/cli/vault-admin.ts`) — left as a
  // follow-up rather than widening this issue's CLI surface further.
  ipcMain.handle(
    Channel.VAULTS_DELETE,
    async (_e, input: { vaultId: string }): Promise<{ deleted: true }> => {
      const gatewayId = await assertLocalAdmin();
      const settings = await loadSettings();
      // Never delete the vault the client is currently addressing — clear
      // the pointer first so the next request falls back to the default.
      let next: DesktopSettings | undefined;
      if (settings.activeVaultId === input.vaultId) {
        next = await setActiveVaultId(undefined);
        await invalidateVaultCaches();
      }
      const { deleteLocalVault } = await import('./local-gateway.js');
      deleteLocalVault(gatewayId, input.vaultId);
      // Every other vault-mutating handler (create/switch/pair/ssh-connect)
      // broadcasts VAULT_CHANGED so the renderer's active-vault state
      // (sidebar head, switcher, Settings -> Space) re-reads itself. This
      // one didn't — deleting the ACTIVE vault left the shell showing the
      // just-deleted vault's name until some unrelated event happened to
      // refresh it (found via live E2E, issue #382).
      if (next) broadcastVaultChanged(next);
      return { deleted: true };
    },
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
    async (_e, input: { id: string }): Promise<PublishStatus> => getPublishStatus(input.id),
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
  ipcMain.handle(Channel.GATEWAY_RUNTIME_GET, async () => getGatewayRuntimeSnapshot());

  // Manual restart of the embedded LOCAL gateway (issue #351): refused for
  // a remote gateway (nothing here to restart — that's the server's job).
  // `restartLocalGateway` always mints a fresh per-launch bearer token
  // (same as first boot, since no `token` option is passed to `serve()`),
  // so on success this invalidates the renderer's HTTP-client auth caches
  // and re-broadcasts the active gateway — the same plumbing a gateway
  // switch runs, just without an id change.
  ipcMain.handle(Channel.GATEWAY_RESTART, async (): Promise<{ ok: boolean; error?: string }> => {
    const settings = await loadSettings();
    if (settings.activeGatewayKind !== 'local') {
      return { ok: false, error: 'remote gateways restart server-side' };
    }
    try {
      const { restartLocalGateway } = await import('./local-gateway.js');
      await restartLocalGateway(settings.activeGatewayId);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    await invalidateGatewayCaches();
    const next = await loadSettings();
    broadcastGatewayChanged(next);
    nudgeGatewayMonitor();
    return { ok: true };
  });

  // Fetch the active gateway's diagnostics bundle and save it via a native
  // dialog (issue #351). Pure orchestration lives in gateway-ops-core.ts;
  // gateway-ops.ts wires in the real dialog/fs/settings.
  ipcMain.handle(Channel.GATEWAY_DIAGNOSTICS_EXPORT, async () => {
    const { exportActiveGatewayDiagnostics } = await import('./gateway-ops.js');
    return exportActiveGatewayDiagnostics();
  });

  ipcMain.handle(
    Channel.GATEWAY_AUTH_GET,
    async (): Promise<{ baseUrl: string; token?: string; vaultId?: string }> => {
      const settings = await loadSettings();
      return {
        baseUrl: settings.gatewayUrl.replace(/\/+$/, ''),
        token: settings.gatewayToken || undefined,
        // The vault the renderer addresses on this gateway (#289) — sent as
        // the `x-centraid-vault` header. Undefined = let the gateway pick.
        ...(settings.activeVaultId !== undefined ? { vaultId: settings.activeVaultId } : {}),
      };
    },
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
  ipcMain.handle(Channel.PHONE_REVOKE, async (_e, input: { deviceId: string }) => {
    const removed = revokePhoneDevice(input.deviceId);
    return { removed: Boolean(removed) };
  });

  // ----- Relaunch to update -----
  // Status snapshot for windows that mount after the UPDATE_AVAILABLE
  // broadcast; relaunch restarts the process so it loads the new dist.
  ipcMain.handle(Channel.UPDATE_STATUS, async () => getUpdateStatus());
  ipcMain.handle(Channel.UPDATE_RELAUNCH, async () => {
    relaunchToUpdate();
    return { ok: true as const };
  });

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
