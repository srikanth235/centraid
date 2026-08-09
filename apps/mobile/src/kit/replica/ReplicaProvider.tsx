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
import { borrowedChangeFeed } from "../../lib/replica/borrowed-change-feed";
import { requireMobileOfflineGateway } from "../../lib/replica/mobile-gateway-compatibility";
import { MobileGatewayCompatibilityError } from "../../lib/replica/mobile-gateway-compatibility-core";
import type { MobileCompatibilityDisposition } from "../../lib/replica/mobile-gateway-compatibility-core";
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
import { postLend, postPlacement } from "../../lib/replica/placement-transport";
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

// Re-exported rather than moved outright: the pairing wall copy is what a
// consumer of this provider asks for, and `replica-mount` is an implementation
// detail of it.
export { REPLICA_UNPAIRED_MESSAGE } from "./replica-mount";

// Re-exported rather than declared here: `./replica-status` is the pure
// module that owns what each reachability state MEANS to a member (see its
// header), so it is the one that gets to name the union. This provider is
// just what a consumer of the type asks for.
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
  /** Re-resolve the gateway and pull every mounted source. */
  refresh?: () => Promise<void>;
  /** C1(b) is a blocking wall: no route-specific degraded modes on skew. */
  compatibility?: MobileCompatibilityDisposition;
  error?: string;
  /** The real signal behind the `out of room` state (#708): the driver hit
   *  SQLITE_FULL/ENOSPC opening or reading a replica. */
  storageFull?: boolean;
}

const REPLICA_LOADING: ReplicaContextValue = {
  scopes: [],
  ready: false,
  online: false,
  reachability: "device-offline",
};
const ReplicaContext = createContext<ReplicaContextValue>(REPLICA_LOADING);

/**
 * Long enough to let a wifi/cellular handoff settle, short enough that walking
 * back into range still feels like the app noticed.
 */
const NETWORK_FLAP_WINDOW_MS = 1_500;

/**
 * Resolve once the navigation animation and pending touches have run. React
 * Native's own scheduler owns this — nothing here should be guessing at a
 * timeout for "the UI is usable now".
 */
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
        // Opening one replica database per scope runs its schema migrations
        // synchronously, and the first frame is competing with them. Nothing
        // here is on screen yet, so let the launch animation and first paint
        // finish before taking the JS thread.
        await afterInteractions();
        if (cancelled) return;
        // PHASE A: decide what to open from disk alone (mount-plan.ts). A
        // device that already has a (gateway, vault) tuple on disk — the
        // registry row, or the active-slot projection it falls back to —
        // opens that replica IMMEDIATELY, offline, without a single await on
        // the network. `resolveIdentity` (phase B's own network-dependent
        // ladder) only runs for a genuinely fresh install, where the gateway
        // holds the only copy of the answer. This is the fix for the defect
        // this file's header describes: "unpaired" is a DISK fact, never a
        // network verdict — a plan can only end in the pairing wall (via
        // `resolveIdentity`'s `REPLICA_UNPAIRED_MESSAGE`) when phase A looked
        // at every persisted identity there is and found none.
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
        await requireMobileOfflineGateway({
          baseUrl: identity.auth.baseUrl,
          online: identity.online,
        });
        const storageLocation = replicaStorageDirectory();
        const scopes = await mountedScopes(identity, storageLocation);
        const freshness = await loadFreshness(identity.gatewayId, scopes);
        // Push registration, the daily brief and the per-scope notification
        // syncs are all "eventually" work, fired once the JS thread is free
        // rather than racing the first frame — and fired at most ONCE per
        // mount, from whichever of two moments notices the gateway is
        // actually reachable first. Gating this purely on `identity.online`
        // at mount would mean a returning device — which now mounts OFFLINE
        // by design, from the plan above — never registers for push again
        // until it happens to relaunch while already online; `sendEventualWork`
        // is the other trigger, called again from `refreshReachability` the
        // first time a live base resolves.
        let sentEventualWork = false;
        const sendEventualWork = (baseUrl: string): void => {
          if (sentEventualWork) return;
          sentEventualWork = true;
          void afterInteractions().then(() => {
            if (cancelled) return;
            void registerReplicaPushWake(baseUrl);
            void scheduleDailyBriefNotification();
            for (const scope of scopes) {
              if (scope.borrowed) continue;
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
              changeFeed: scope.borrowed
                ? borrowedChangeFeed()
                : multiplex!.scope(scope.vaultId),
              ...(scope.borrowed
                ? { borrowedEdgeId: scope.borrowed.edgeId }
                : {}),
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
          sendLend: (input) => postLend(currentBase, input),
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
            // THE WALL, RE-RAISED. The mount fails open offline (an
            // unanswered question is not a judgment — see the module's
            // header), which makes this the one moment skew becomes a
            // provable fact: a gateway just answered. An incompatible answer
            // flips the session to the blocking disposition instead of
            // letting pulls proceed against a wire contract this build does
            // not speak.
            try {
              await requireMobileOfflineGateway({
                baseUrl: liveBase,
                online: true,
              });
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
            // Phase A (mount-plan.ts) never asks the gateway anything, so
            // THIS pass is the only one that can notice a scope granted since
            // the last launch. Priming the cache here does not remount a live
            // session — it just primes `mountedScopes` for the next mount
            // (see refreshCachedScopes / mountedScopes in replica-mount.ts).
            void refreshCachedScopes(identity.gatewayId, liveBase);
            // The other trigger for the once-only eventual work: a returning
            // device mounted offline by design, so this is the first moment
            // it can register for push / notifications this launch.
            sendEventualWork(liveBase);
          }
          setBuilt((current) =>
            current?.gatewayKey === gatewayKey
              ? {
                  gatewayKey,
                  value: {
                    ...current.value,
                    ...(liveBase ? { gatewayBase: liveBase } : {}),
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
            // `pullNow` is optional-chained — no facade means no pull, which
            // is not success — so this settle is unconditional. Without it, a
            // pull that never lands (gateway answered the base but died
            // before the pull, or the facade was never built) leaves
            // "Syncing recent changes…" on screen forever: `syncing` above was
            // set OPTIMISTICALLY, before the pull was even attempted, so
            // every pass that reaches this point MUST settle somewhere.
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
            online: connected,
            // `device-offline`, not `gateway-asleep`: at this instant phase A
            // has looked only at disk (mount-plan.ts), so nothing is known
            // about the gateway either way — `gateway-asleep` is a verdict,
            // and this is the moment before any verdict exists. Mounting at
            // `gateway-asleep` flashed a red "Wake help" row on every cold
            // start for the seconds until `refreshReachability` (phase B)
            // actually reached the network. `device-offline` is the bar's
            // silent state (see replica-status.ts) — silence until something
            // is known beats a false alarm.
            reachability: connected ? "current" : "device-offline",
            refresh,
          },
        });
        // Wifi/cellular handoff emits several states in a row, and each one used
        // to re-resolve the gateway base and pull every scope. The states are
        // not individually actionable — only the settled one is — so they
        // collapse into one reachability pass. A manual refresh stays direct.
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
