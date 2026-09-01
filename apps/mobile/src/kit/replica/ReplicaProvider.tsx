import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Network from "expo-network";
import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppState, InteractionManager } from "react-native";

import { replicaStorageDirectory } from "../../../modules/centraid-storage";
import { coalesceWork } from "../../lib/coalesce";
import type { CoalescedWork } from "../../lib/coalesce";
import { scheduleDailyBriefNotification } from "../../lib/daily-brief";
import { resolveGatewayBase } from "../../lib/gateway";
import {
  syncDueNotifications,
  syncNotifications,
} from "../../lib/notifications-core";
import { registerReplicaPushWake } from "../../lib/replica/background-sync";
import { requireMobileOfflineGateway } from "../../lib/replica/mobile-gateway-compatibility";
import { MobileGatewayCompatibilityError } from "../../lib/replica/mobile-gateway-compatibility-core";
import { MultiVaultReplicaReader } from "../../lib/replica/multi-vault-reader";
import type { MountedReplicaScope } from "../../lib/replica/multi-vault-reader";
import { MultiVaultReplicaSession } from "../../lib/replica/multi-vault-session";
import {
  nativeReplicaDigest,
  nativeReplicaIdFactory,
} from "../../lib/replica/native-hash";
import { NativeMultiplexChangeFeed } from "../../lib/replica/native-multiplex-change-feed";
import { createNativeReplicaSession } from "../../lib/replica/native-session";
import type { NativeReplicaSession } from "../../lib/replica/native-session";
import { MOBILE_REPLICA_BOOTSTRAP_WINDOW } from "../../lib/replica/offline-budgets";
import {
  openMountedReplicaReaderDriver,
  openNativeReplicaDriver,
} from "../../lib/replica/op-sqlite-driver";
import {
  postCommons,
  postPlacement,
} from "../../lib/replica/placement-transport";
import { isReplicaStorageFullError } from "../../lib/replica/replica-storage-error";
import { clearPinnedThumbnailPack } from "../../lib/replica/thumbnail-pack";
import { nativeSyncAllowed } from "../../lib/upload/native-policy";
import {
  LAST_BASE,
  LAST_GATEWAY,
  LAST_VAULT,
  getActiveVaultLink,
  hydrateVaultLinks,
  subscribeVaultLinks,
} from "../../lib/vault-links";
import type { VaultLink } from "../../lib/vault-links";
import { Store } from "../../storage";
import { planMount } from "./mount-plan";
import {
  createBootstrapTracker,
  createFreshnessStore,
  createRevokedNoticeStore,
  REPLICA_LOADING,
} from "./replica-context";
import type {
  PublishReplicaValue,
  ReplicaContextValue,
} from "./replica-context";
import {
  deleteReplicaDatabaseFamily,
  discardRestoredReplicaCache,
  fetcher,
  loadFreshness,
  mountedScopes,
  refreshCachedScopes,
  removeCachedScope,
  resolveIdentity,
} from "./replica-mount";
import {
  attemptedReachability,
  loadRevokedNotices,
  settledReachability,
} from "./replica-status";

export { REPLICA_UNPAIRED_MESSAGE } from "./replica-mount";

export type { ReplicaReachability } from "./replica-status";
export type {
  ReplicaBootstrapProgress,
  ReplicaContextValue,
  ReplicaScopeFreshness,
} from "./replica-context";

const ReplicaContext = createContext<ReplicaContextValue>(REPLICA_LOADING);

/** Long enough for a wifi/cellular handoff to settle, short enough to feel live. */
const NETWORK_FLAP_WINDOW_MS = 1_500;

/**
 * Quiet window before a freshness stamp reaches AsyncStorage and the context.
 * Only the newest stamp matters and losing an unwritten one costs a replay,
 * not data, so a busy frame pays one disk write and one rebuild, not one per
 * advancing scope (matches native-change-feed.ts).
 */
const FRESHNESS_COMMIT_WINDOW_MS = 1_000;

/** RN's scheduler owns "the UI is usable now" — never substitute a timeout. */
function afterInteractions(): Promise<void> {
  return new Promise((resolve) => {
    InteractionManager.runAfterInteractions(() => resolve());
  });
}

export function ReplicaProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [active, setActive] = useState<VaultLink | undefined>();
  const activeRef = useRef<VaultLink | undefined>(undefined);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    let unsubscribe = (): void => undefined;
    void hydrateVaultLinks().then(() => {
      const update = (): void => {
        const vault = getActiveVaultLink();
        activeRef.current = vault;
        setActive(vault);
      };
      update();
      setHydrated(true);
      unsubscribe = subscribeVaultLinks(update);
    });
    return () => unsubscribe();
  }, []);

  const gatewayKey = active?.gatewayId ?? (hydrated ? "unpaired" : "loading");
  const activeVaultId = active?.vaultId;
  const [retryNonce, setRetryNonce] = useState(0);
  const [mountNonce, setMountNonce] = useState(0);
  const [built, setBuilt] = useState<{
    gatewayKey: string;
    value: ReplicaContextValue;
  }>();

  // Activating a vault outside the mounted four RE-PLANS the mount: a bare
  // re-key of the write target leaves the Space just opened unreadable until
  // relaunch. The four-scope cap (docs/mobile-offline.md) bounds what is open
  // at once, not which vaults a member may open.
  const remountedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (
      !activeVaultId ||
      built?.gatewayKey !== gatewayKey ||
      !built.value.ready
    )
      return;
    if (built.value.scopes?.some((scope) => scope.vaultId === activeVaultId)) {
      remountedFor.current = undefined;
      return;
    }
    // One attempt per vault. A scope the gateway will not hand back — revoked
    // mid-mount, or gone from the manifest — must not spin the mount forever.
    if (remountedFor.current === activeVaultId) return;
    remountedFor.current = activeVaultId;
    // Retract the published session BEFORE the teardown: consumers read
    // `ready` and stop, so no read lands on a closing facade. Outboxes are
    // per-vault SQLite files, so no queued write is at risk.
    setBuilt(undefined);
    setMountNonce((current) => current + 1);
  }, [activeVaultId, built, gatewayKey]);

  useEffect(() => {
    if (!hydrated || gatewayKey === "loading") return undefined;
    let cancelled = false;
    let facade: MultiVaultReplicaSession | undefined;
    let multiplex: NativeMultiplexChangeFeed | undefined;
    let networkSubscription: { remove: () => void } | undefined;
    let reachabilityWork: CoalescedWork | undefined;
    let freshnessWork: CoalescedWork | undefined;
    let flushFreshness = async (): Promise<void> => undefined;
    const looseDrivers: Array<{ close: () => void }> = [];
    // Every mid-mount update goes through here: a torn-down mount publishes
    // nothing, and a mount whose gateway key has moved on never overwrites its
    // successor.
    const publish: PublishReplicaValue = (patch) => {
      if (cancelled) return;
      setBuilt((current) =>
        current?.gatewayKey === gatewayKey
          ? { gatewayKey, value: patch(current.value) }
          : current
      );
    };

    void (async () => {
      try {
        // Opening a replica per scope runs migrations synchronously — yield first.
        await afterInteractions();
        if (cancelled) return;
        // PHASE A decides what to open from disk alone (`planMount`): a device
        // holding a (gateway, vault) tuple opens that replica offline, with no
        // await on the network. `resolveIdentity` is for a fresh install only.
        // "unpaired" is a DISK fact, never a network verdict — keep it that way.
        const [cachedBase, lastGatewayId, lastVaultId] = await Promise.all([
          Store.hydrate(LAST_BASE, "http://127.0.0.1"),
          Store.hydrate(LAST_GATEWAY, ""),
          Store.hydrate(LAST_VAULT, ""),
        ]);
        const plan = planMount({
          link: activeRef.current,
          cachedBase,
          lastIdentity: { gatewayId: lastGatewayId, vaultId: lastVaultId },
        });
        const identity: Awaited<ReturnType<typeof resolveIdentity>> =
          plan.kind === "open"
            ? {
                auth: {
                  baseUrl: plan.baseUrl,
                  gatewayId: plan.gatewayId,
                  vaultId: plan.vaultId,
                },
                gatewayId: plan.gatewayId,
                online: false,
              }
            : await resolveIdentity(activeRef.current);
        if (cancelled) return;
        // One `/info` read raises the wall and settles the flags, not one per surface.
        let features = await requireMobileOfflineGateway({
          baseUrl: identity.auth.baseUrl,
          online: identity.online,
        });
        const storageLocation = replicaStorageDirectory();
        const scopes = await mountedScopes(identity, storageLocation);
        // BEFORE any stamp or cursor is read. A restored container carries the
        // previous device's resume cursors over an empty replica; resuming from
        // one loses every change beneath it, silently.
        await discardRestoredReplicaCache(identity.gatewayId, scopes);
        // At most ONCE per mount, from whichever moment first sees the gateway
        // reachable: gating on `identity.online` alone leaves a device that
        // mounted offline unregistered for push until it relaunches online.
        let sentEventualWork = false;
        const sendEventualWork = (baseUrl: string): void => {
          if (sentEventualWork) return;
          sentEventualWork = true;
          void afterInteractions().then(() => {
            if (cancelled) return;
            void registerReplicaPushWake(baseUrl);
            void scheduleDailyBriefNotification();
            for (const scope of scopes) {
              void syncDueNotifications(baseUrl, scope.vaultId);
              void syncNotifications(baseUrl, scope.vaultId);
            }
          });
        };
        if (identity.online) sendEventualWork(identity.auth.baseUrl);
        if (cancelled) return;
        let connected = identity.online;
        // Reports, never decides (docs/traps/unreachable-vault.md).
        const noteGatewayOutcome = (reachable: boolean): void => {
          if (cancelled || reachable === connected) return;
          reachabilityWork?.signal();
        };
        const sessions = new Map<string, NativeReplicaSession>();
        // Kept per vault, not just until the session takes over: a revoked
        // scope's file cannot be deleted while its handle is still open, and
        // `purge()` deliberately leaves that handle alive.
        const scopeDrivers = new Map<string, { close: () => void }>();
        const revokedScopeIds = new Set<string>();
        const reclaimRevokedReplica = (scope: MountedReplicaScope): void => {
          try {
            scopeDrivers.get(scope.vaultId)?.close();
          } catch {
            // A handle the purge already tore down is one less thing to close.
          }
          scopeDrivers.delete(scope.vaultId);
          deleteReplicaDatabaseFamily(scope.databaseName);
        };
        const bootstrap = createBootstrapTracker(publish);
        const freshness = createFreshnessStore({
          storage: AsyncStorage,
          gatewayId: identity.gatewayId,
          initial: await loadFreshness(identity.gatewayId, scopes),
          publish,
        });
        freshnessWork = coalesceWork(
          freshness.commit,
          FRESHNESS_COMMIT_WINDOW_MS
        );
        const updateScopeFreshness = (vaultId: string): void => {
          freshness.stamp(vaultId);
          freshnessWork?.signal();
        };
        // Teardown is the last reliable moment to land a stamp, exactly as
        // backgrounding is for the feed's resume cursor.
        flushFreshness = freshness.commit;
        const revoked = createRevokedNoticeStore({
          storage: AsyncStorage,
          gatewayId: identity.gatewayId,
          initial: await loadRevokedNotices(AsyncStorage, identity.gatewayId),
          publish,
        });
        multiplex = new NativeMultiplexChangeFeed({
          gatewayAuth: {
            baseUrl: identity.auth.baseUrl,
            gatewayId: identity.gatewayId,
          },
          storage: AsyncStorage,
          onStreamOutcome: noteGatewayOutcome,
          onScopeUpdated: updateScopeFreshness,
          onScopeRevoked: (vaultId) => {
            revokedScopeIds.add(vaultId);
            void (async () => {
              try {
                if (facade) await facade.revokeScope(vaultId);
                else {
                  // Revoked before the facade exists: the same trace is owed.
                  const scope = scopes.find(
                    (candidate) => candidate.vaultId === vaultId
                  );
                  if (scope) revoked.note(scope);
                  await sessions.get(vaultId)?.purge();
                  if (scope) reclaimRevokedReplica(scope);
                }
              } finally {
                sessions.delete(vaultId);
                bootstrap.forget(vaultId);
                clearPinnedThumbnailPack(vaultId);
                freshness.forget(vaultId);
                await removeCachedScope(identity.gatewayId, vaultId).catch(
                  () => undefined
                );
                publish((value) => ({
                  ...value,
                  scopes: (value.scopes ?? []).filter(
                    (scope) => scope.vaultId !== vaultId
                  ),
                  bootstrapProgress: bootstrap.current(),
                }));
              }
            })().catch(() => undefined);
          },
        });
        let currentBase = identity.auth.baseUrl;
        await Promise.all(
          scopes.map(async (scope) => {
            const driver = await openNativeReplicaDriver(
              { gatewayId: identity.gatewayId, vaultId: scope.vaultId },
              nativeReplicaDigest,
              storageLocation
            );
            looseDrivers.push(driver);
            const session = await createNativeReplicaSession({
              gatewayAuth: {
                ...identity.auth,
                vaultId: scope.vaultId,
              },
              fetcher: fetcher(scope.vaultId),
              changeFeed: multiplex!.scope(scope.vaultId),
              driver,
              appState: AppState,
              isConnected: () => connected,
              isNetworkWorkAllowed: nativeSyncAllowed,
              bootstrapWindow: MOBILE_REPLICA_BOOTSTRAP_WINDOW,
              progressiveBootstrap: true,
              // A vault the member does not steward is one a queued write may
              // have to wait for somebody at, so its pending rows carry a
              // steward label from admission (`steward-label.ts`). `personal`
              // is the founding marker; an older cache omits it and reads as
              // their own, which is the answer that promises nothing.
              ...(scope.personal === false ? { steward: {} } : {}),
              onBootstrapProgress: (progress) =>
                bootstrap.report(scope, progress),
              onGatewayOutcome: noteGatewayOutcome,
              // Out of room parks this scope's feed; the phone, not the vault,
              // is what ran out, so one paused scope raises the state for all.
              onStorageFull: () =>
                publish((value) => ({ ...value, storageFull: true })),
            });
            if (revokedScopeIds.has(scope.vaultId)) {
              await session.purge();
              looseDrivers.splice(looseDrivers.indexOf(driver), 1);
              scopeDrivers.set(scope.vaultId, driver);
              reclaimRevokedReplica(scope);
              return;
            }
            sessions.set(scope.vaultId, session);
            scopeDrivers.set(scope.vaultId, driver);
            looseDrivers.splice(looseDrivers.indexOf(driver), 1);
          })
        );
        const readerDriver = await openMountedReplicaReaderDriver(
          identity.gatewayId,
          nativeReplicaDigest,
          storageLocation
        );
        looseDrivers.push(readerDriver);
        const liveScopes = scopes.filter(
          (scope) => !revokedScopeIds.has(scope.vaultId)
        );
        const reader = new MultiVaultReplicaReader(readerDriver, liveScopes);
        looseDrivers.splice(looseDrivers.indexOf(readerDriver), 1);
        facade = new MultiVaultReplicaSession({
          reader,
          sessions,
          scopes: liveScopes,
          focusedVaultId: () => activeRef.current?.vaultId,
          createId: nativeReplicaIdFactory,
          isConnected: () => connected,
          isNetworkWorkAllowed: nativeSyncAllowed,
          onScopePulled: updateScopeFreshness,
          onScopeRevoked: revoked.note,
          reclaimRevokedReplica,
          sendPlacement: (input) => postPlacement(currentBase, input),
          sendCommons: (input) => postCommons(currentBase, input),
        });
        if (cancelled) {
          await facade.close();
          return;
        }
        // Durable coverage, read at mount and after every pull. Without it a
        // relaunch after a kill mid-backfill renders a truncated library with
        // nothing saying so: the in-process bootstrap that would have reported
        // pages died with the old process (docs/mobile-offline.md).
        const refreshCoverage = async (): Promise<void> => {
          const status = await facade?.status().catch(() => undefined);
          if (!status) return;
          publish((value) => ({
            ...value,
            coverage: status.coverage,
            scopes: (value.scopes ?? []).map((scope) => {
              const coverage = status.scopes.find(
                (entry) => entry.vaultId === scope.vaultId
              )?.coverage;
              return coverage ? { ...scope, coverage } : scope;
            }),
          }));
        };
        const refreshReachability = async (
          network: Network.NetworkState
        ): Promise<void> => {
          const deviceOnline = network.isConnected === true;
          const liveBase = deviceOnline
            ? await resolveGatewayBase().catch(() => undefined)
            : undefined;
          if (cancelled) return;
          connected = liveBase !== undefined;
          if (liveBase) {
            currentBase = liveBase;
            Store.set(LAST_BASE, liveBase);
            multiplex?.updateGatewayBase(liveBase);
            facade?.updateGatewayBase(liveBase);
            facade?.notifyReachable();
            // THE WALL, RE-RAISED. The mount fails open offline, so this is the
            // one moment skew is provable: a gateway just answered. Incompatible
            // flips to the blocking disposition rather than pulling against a
            // contract this build cannot speak; the same answer settles the flags.
            try {
              features =
                (await requireMobileOfflineGateway({
                  baseUrl: liveBase,
                  online: true,
                })) ?? features;
            } catch (wallError) {
              if (wallError instanceof MobileGatewayCompatibilityError) {
                publish((value) => ({
                  ...value,
                  compatibility: wallError.disposition,
                }));
                return;
              }
              throw wallError;
            }
            // Phase A asks the gateway nothing, so only this pass notices a scope
            // granted since launch. Priming does not remount — `mountedScopes`
            // picks it up next mount.
            void refreshCachedScopes(identity.gatewayId, liveBase);
            // The other trigger: a device that mounted offline can only register
            // for push here.
            sendEventualWork(liveBase);
          }
          publish((value) => ({
            ...value,
            ...(liveBase ? { gatewayBase: liveBase } : {}),
            ...(features ? { features } : {}),
            online: value.online === true && connected,
            // The one pass that runs whatever the radio said: re-read the
            // pause so a resume from the storage screen clears the state.
            storageFull: facade?.storageFull === true,
            reachability: attemptedReachability(
              deviceOnline,
              liveBase !== undefined,
              value.online === true
            ),
          }));
          if (liveBase) {
            const outcome = await facade?.pullScopes().catch(() => undefined);
            // `syncing` above is set OPTIMISTICALLY, so every pass reaching here
            // MUST settle: an unconditional settle is what stops a pull that
            // never lands from pinning "Syncing recent changes…" on screen.
            //
            // A pull the transfer rules refused is NOT a landed pull: reading
            // the refusal as freshness paints a settled, silent `current` over
            // data that was never fetched.
            const policyBlocked = outcome?.policyBlocked === true;
            const landed = outcome !== undefined && !policyBlocked;
            connected = landed || policyBlocked;
            await refreshCoverage();
            publish((value) => ({
              ...value,
              // The gateway answered `/info`; the rules, not the radio,
              // stopped the pull, so connectivity stands.
              online: policyBlocked ? connected : landed,
              reachability: settledReachability(landed, policyBlocked),
            }));
          }
        };
        const refresh = async (): Promise<void> => {
          await refreshReachability(await Network.getNetworkStateAsync());
        };
        setBuilt({
          gatewayKey,
          value: {
            session: facade,
            gatewayBase: identity.auth.baseUrl,
            vaultId: activeRef.current?.vaultId ?? identity.auth.vaultId,
            scopes: liveScopes.map((scope) => ({
              ...scope,
              ...(freshness.get(scope.vaultId)
                ? { updatedAt: freshness.get(scope.vaultId) }
                : {}),
            })),
            bootstrapProgress: bootstrap.current(),
            ...(revoked.current().length > 0
              ? { revokedNotices: revoked.current() }
              : {}),
            dismissRevokedNotice: revoked.forget,
            ready: true,
            ...(features ? { features } : {}),
            online: connected,
            // `device-offline`, not `gateway-asleep`: phase A has read only disk,
            // so no verdict about the gateway exists yet. `gateway-asleep` here
            // flashes a red "Wake help" row on every cold start; silence wins.
            reachability: connected ? "current" : "device-offline",
            refresh,
          },
        });
        // A handoff emits several states in a row and only the settled one is
        // actionable, so they collapse into one pass. Manual refresh stays direct.
        let latestNetwork: Network.NetworkState | undefined;
        reachabilityWork = coalesceWork(async () => {
          const network =
            latestNetwork ?? (await Network.getNetworkStateAsync());
          await refreshReachability(network);
        }, NETWORK_FLAP_WINDOW_MS);
        networkSubscription = Network.addNetworkStateListener((network) => {
          latestNetwork = network;
          reachabilityWork?.signal();
        });
        void refreshCoverage();
        void afterInteractions().then(() => {
          if (!cancelled) void refresh();
        });
      } catch (error) {
        if (!cancelled) {
          const compatibility =
            error instanceof MobileGatewayCompatibilityError
              ? error.disposition
              : undefined;
          setBuilt({
            gatewayKey,
            value: {
              scopes: [],
              ready: true,
              online: false,
              reachability: "gateway-asleep",
              refresh: async () => setRetryNonce((current) => current + 1),
              ...(compatibility ? { compatibility } : {}),
              ...(isReplicaStorageFullError(error)
                ? { storageFull: true }
                : {}),
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      reachabilityWork?.cancel();
      freshnessWork?.cancel();
      // Cancel drops the timer, not the stamps: land them before the mount goes.
      void flushFreshness();
      networkSubscription?.remove();
      void facade?.close();
      multiplex?.close();
      for (const driver of looseDrivers) driver.close();
    };
  }, [gatewayKey, hydrated, mountNonce, retryNonce]);

  const base = built?.gatewayKey === gatewayKey ? built.value : REPLICA_LOADING;
  const value = {
    ...base,
    ...(active?.vaultId ? { vaultId: active.vaultId } : {}),
  };
  return (
    <ReplicaContext.Provider value={value}>{children}</ReplicaContext.Provider>
  );
}

export function useReplica(): ReplicaContextValue {
  return useContext(ReplicaContext);
}
