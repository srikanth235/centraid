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
import {
  nativeRowSyncAllowed,
  nativeSyncAllowed,
} from "../../lib/upload/native-policy";
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

const NETWORK_FLAP_WINDOW_MS = 1_500;

const FRESHNESS_COMMIT_WINDOW_MS = 1_000;

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
    if (remountedFor.current === activeVaultId) return;
    remountedFor.current = activeVaultId;
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
        await afterInteractions();
        if (cancelled) return;
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
        let features = await requireMobileOfflineGateway({
          baseUrl: identity.auth.baseUrl,
          online: identity.online,
        });
        const storageLocation = replicaStorageDirectory();
        const scopes = await mountedScopes(identity, storageLocation);
        await discardRestoredReplicaCache(identity.gatewayId, scopes);
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
        const noteGatewayOutcome = (reachable: boolean): void => {
          if (cancelled || reachable === connected) return;
          reachabilityWork?.signal();
        };
        const sessions = new Map<string, NativeReplicaSession>();
        const scopeDrivers = new Map<string, { close: () => void }>();
        const revokedScopeIds = new Set<string>();
        const reclaimRevokedReplica = (scope: MountedReplicaScope): void => {
          try {
            scopeDrivers.get(scope.vaultId)?.close();
          } catch {
            // Intentionally empty.
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
              isRowSyncAllowed: nativeRowSyncAllowed,
              bootstrapWindow: MOBILE_REPLICA_BOOTSTRAP_WINDOW,
              progressiveBootstrap: true,
              ...(scope.personal === false ? { steward: {} } : {}),
              onBootstrapProgress: (progress) =>
                bootstrap.report(scope, progress),
              onGatewayOutcome: noteGatewayOutcome,
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
          isRowSyncAllowed: nativeRowSyncAllowed,
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
          if (!liveBase)
            console.error(
              `[centraid] replica: no gateway base — device=${deviceOnline}`
            );
          if (liveBase) {
            currentBase = liveBase;
            Store.set(LAST_BASE, liveBase);
            multiplex?.updateGatewayBase(liveBase);
            facade?.updateGatewayBase(liveBase);
            facade?.notifyReachable();
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
            void refreshCachedScopes(identity.gatewayId, liveBase);
            sendEventualWork(liveBase);
          }
          publish((value) => ({
            ...value,
            ...(liveBase ? { gatewayBase: liveBase } : {}),
            ...(features ? { features } : {}),
            online: value.online === true && connected,
            storageFull: facade?.storageFull === true,
            reachability: attemptedReachability(
              deviceOnline,
              liveBase !== undefined,
              value.online === true
            ),
          }));
          if (liveBase) {
            const outcome = await facade?.pullScopes().catch(() => undefined);
            const policyBlocked = outcome?.policyBlocked === true;
            const landed = outcome !== undefined && !policyBlocked;
            connected = landed || policyBlocked;
            if (!landed)
              console.error(
                `[centraid] replica: scopes pull did not land — blocked=${policyBlocked}`
              );
            await refreshCoverage();
            publish((value) => ({
              ...value,
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
            reachability: connected ? "current" : "device-offline",
            refresh,
          },
        });
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
