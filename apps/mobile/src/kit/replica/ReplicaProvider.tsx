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
import type {
  MobileCompatibilityDisposition,
  MobileGatewayFeatures,
} from "../../lib/replica/mobile-gateway-compatibility-core";
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
  fetcher,
  freshnessKey,
  loadFreshness,
  mountedScopes,
  refreshCachedScopes,
  removeCachedScope,
  resolveIdentity,
} from "./replica-mount";
import { settledReachability } from "./replica-status";
import type { ReplicaReachability } from "./replica-status";

export { REPLICA_UNPAIRED_MESSAGE } from "./replica-mount";

export type { ReplicaReachability } from "./replica-status";

export interface ReplicaScopeFreshness extends MountedReplicaScope {
  updatedAt?: string;
}

export interface ReplicaBootstrapProgress {
  vaultId: string;
  vaultLabel: string;
  phase: "first-page" | "backfill";
  pages: number;
}

export interface ReplicaContextValue {
  session?: MultiVaultReplicaSession;
  gatewayBase?: string;
  /** Visible VaultLink filter / default write target; not a session identity. */
  vaultId?: string;
  scopes?: readonly ReplicaScopeFreshness[];
  ready: boolean;
  online: boolean;
  reachability?: ReplicaReachability;
  bootstrapProgress?: readonly ReplicaBootstrapProgress[];
  refresh?: () => Promise<void>;
  /** C1(b) is a blocking wall: no route-specific degraded modes on skew. */
  compatibility?: MobileCompatibilityDisposition;
  /** `undefined` is UNKNOWN, not off — a gated surface stays visible until a
   *  gateway answers. */
  features?: MobileGatewayFeatures;
  error?: string;
  /** The `out of room` state (#708): the driver hit SQLITE_FULL/ENOSPC. */
  storageFull?: boolean;
}

const REPLICA_LOADING: ReplicaContextValue = {
  scopes: [],
  ready: false,
  online: false,
  reachability: "device-offline",
};
const ReplicaContext = createContext<ReplicaContextValue>(REPLICA_LOADING);

/** Long enough for a wifi/cellular handoff to settle, short enough to feel live. */
const NETWORK_FLAP_WINDOW_MS = 1_500;

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
  const [retryNonce, setRetryNonce] = useState(0);
  const [built, setBuilt] = useState<{
    gatewayKey: string;
    value: ReplicaContextValue;
  }>();

  useEffect(() => {
    if (!hydrated || gatewayKey === "loading") return undefined;
    let cancelled = false;
    let facade: MultiVaultReplicaSession | undefined;
    let multiplex: NativeMultiplexChangeFeed | undefined;
    let networkSubscription: { remove: () => void } | undefined;
    let reachabilityWork: CoalescedWork | undefined;
    const looseDrivers: Array<{ close: () => void }> = [];

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
        const freshness = await loadFreshness(identity.gatewayId, scopes);
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
        const sessions = new Map<string, NativeReplicaSession>();
        const revokedScopeIds = new Set<string>();
        const bootstrapProgress = new Map<string, ReplicaBootstrapProgress>();
        const reportBootstrapProgress = (
          scope: MountedReplicaScope,
          progress: {
            phase: "first-page" | "backfill" | "complete";
            pages: number;
          }
        ): void => {
          if (cancelled) return;
          if (progress.phase === "complete") {
            bootstrapProgress.delete(scope.vaultId);
          } else {
            bootstrapProgress.set(scope.vaultId, {
              vaultId: scope.vaultId,
              vaultLabel: scope.label,
              phase: progress.phase,
              pages: progress.pages,
            });
          }
          setBuilt((current) =>
            current?.gatewayKey === gatewayKey
              ? {
                  gatewayKey,
                  value: {
                    ...current.value,
                    bootstrapProgress: [...bootstrapProgress.values()],
                  },
                }
              : current
          );
        };
        const updateScopeFreshness = (vaultId: string): void => {
          const updatedAt = new Date().toISOString();
          freshness.set(vaultId, updatedAt);
          void AsyncStorage.setItem(
            freshnessKey(identity.gatewayId, vaultId),
            updatedAt
          );
          setBuilt((current) =>
            current?.gatewayKey === gatewayKey
              ? {
                  gatewayKey,
                  value: {
                    ...current.value,
                    scopes: (current.value.scopes ?? []).map((scope) =>
                      scope.vaultId === vaultId
                        ? { ...scope, updatedAt }
                        : scope
                    ),
                  },
                }
              : current
          );
        };
        multiplex = new NativeMultiplexChangeFeed({
          gatewayAuth: {
            baseUrl: identity.auth.baseUrl,
            gatewayId: identity.gatewayId,
          },
          storage: AsyncStorage,
          onScopeUpdated: updateScopeFreshness,
          onScopeRevoked: (vaultId) => {
            revokedScopeIds.add(vaultId);
            void (async () => {
              try {
                if (facade) await facade.revokeScope(vaultId);
                else await sessions.get(vaultId)?.purge();
              } finally {
                sessions.delete(vaultId);
                bootstrapProgress.delete(vaultId);
                clearPinnedThumbnailPack(vaultId);
                freshness.delete(vaultId);
                await removeCachedScope(identity.gatewayId, vaultId).catch(
                  () => undefined
                );
                setBuilt((current) =>
                  current?.gatewayKey === gatewayKey
                    ? {
                        gatewayKey,
                        value: {
                          ...current.value,
                          scopes: (current.value.scopes ?? []).filter(
                            (scope) => scope.vaultId !== vaultId
                          ),
                          bootstrapProgress: [...bootstrapProgress.values()],
                        },
                      }
                    : current
                );
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
              onBootstrapProgress: (progress) =>
                reportBootstrapProgress(scope, progress),
            });
            if (revokedScopeIds.has(scope.vaultId)) {
              await session.purge();
              looseDrivers.splice(looseDrivers.indexOf(driver), 1);
              return;
            }
            sessions.set(scope.vaultId, session);
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
          sendPlacement: (input) => postPlacement(currentBase, input),
          sendCommons: (input) => postCommons(currentBase, input),
        });
        if (cancelled) {
          await facade.close();
          return;
        }
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
                setBuilt((current) =>
                  current?.gatewayKey === gatewayKey
                    ? {
                        gatewayKey,
                        value: {
                          ...current.value,
                          compatibility: wallError.disposition,
                        },
                      }
                    : current
                );
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
          setBuilt((current) =>
            current?.gatewayKey === gatewayKey
              ? {
                  gatewayKey,
                  value: {
                    ...current.value,
                    ...(liveBase ? { gatewayBase: liveBase } : {}),
                    ...(features ? { features } : {}),
                    online: connected,
                    reachability: deviceOnline
                      ? liveBase
                        ? "syncing"
                        : "gateway-asleep"
                      : "device-offline",
                  },
                }
              : current
          );
          if (liveBase) {
            const pulled = await facade
              ?.pullNow()
              .then(() => true)
              .catch(() => false);
            // `syncing` above is set OPTIMISTICALLY, so every pass reaching here
            // MUST settle: an unconditional settle is what stops a pull that
            // never lands from pinning "Syncing recent changes…" on screen.
            const landed = pulled === true;
            if (!cancelled) {
              setBuilt((current) =>
                current?.gatewayKey === gatewayKey
                  ? {
                      gatewayKey,
                      value: {
                        ...current.value,
                        online: landed,
                        reachability: settledReachability(landed),
                      },
                    }
                  : current
              );
            }
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
            bootstrapProgress: [...bootstrapProgress.values()],
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
      networkSubscription?.remove();
      void facade?.close();
      multiplex?.close();
      for (const driver of looseDrivers) driver.close();
    };
  }, [gatewayKey, hydrated, retryNonce]);

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
