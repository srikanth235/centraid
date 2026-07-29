import { fetchReplicaBootstrapPage } from "@centraid/client/replica/native";
import type {
  GatewayAuth,
  ReplicaFetcher,
} from "@centraid/client/replica/native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Network from "expo-network";
import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";

import { replicaStorageDirectory } from "../../../modules/centraid-storage";
import { authHeader, resolveGatewayBase } from "../../lib/gateway";
import { getDesktopName } from "../../lib/phone-link";
import { registerReplicaPushWake } from "../../lib/replica/background-sync";
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
import {
  MAX_MOUNTED_NATIVE_SCOPES,
  MOBILE_REPLICA_BOOTSTRAP_WINDOW,
} from "../../lib/replica/offline-budgets";
import {
  nativeReplicaDatabasePath,
  openMountedReplicaReaderDriver,
  openNativeReplicaDriver,
} from "../../lib/replica/op-sqlite-driver";
import { postPlacement } from "../../lib/replica/placement-transport";
import { clearPinnedThumbnailPack } from "../../lib/replica/thumbnail-pack";
import {
  LAST_BASE,
  getActiveSpace,
  hydrateSpaces,
  noteActiveIdentity,
  subscribeSpaces,
} from "../../lib/spaces";
import type { Space } from "../../lib/spaces";
import { nativeSyncAllowed } from "../../lib/upload/native-policy";
import { Store } from "../../storage";

export const REPLICA_UNPAIRED_MESSAGE =
  "Pair a desktop once to create the local replica.";

export type ReplicaReachability =
  | "device-offline"
  | "gateway-asleep"
  | "syncing"
  | "current";

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
  /** Visible Space filter / default write target; not a session identity. */
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
}

interface ScopeWire {
  vaultId: string;
  label: string;
  role: "admin" | "write" | "read";
}

const REPLICA_LOADING: ReplicaContextValue = {
  scopes: [],
  ready: false,
  online: false,
  reachability: "device-offline",
};
const ReplicaContext = createContext<ReplicaContextValue>(REPLICA_LOADING);

function fetcher(vaultId?: string): ReplicaFetcher {
  return async (baseUrl, pathname, init) => {
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(authHeader()))
      headers.set(key, value);
    if (vaultId) headers.set("x-centraid-vault", vaultId);
    return fetch(new URL(pathname, `${baseUrl}/`), {
      ...init,
      headers,
    } as RequestInit);
  };
}

async function resolveIdentity(space: Space | undefined): Promise<{
  auth: GatewayAuth;
  gatewayId: string;
  online: boolean;
}> {
  const cachedBase = await Store.hydrate(LAST_BASE, "http://127.0.0.1");
  if (space?.gatewayId && space.vaultId) {
    const liveBase = await resolveGatewayBase().catch(() => undefined);
    if (liveBase) Store.set(LAST_BASE, liveBase);
    return {
      auth: {
        baseUrl: liveBase ?? cachedBase,
        gatewayId: space.gatewayId,
        vaultId: space.vaultId,
      },
      gatewayId: space.gatewayId,
      online: liveBase !== undefined,
    };
  }
  const liveBase = await resolveGatewayBase().catch(() => undefined);
  if (!liveBase) throw new Error(REPLICA_UNPAIRED_MESSAGE);
  const probe = await fetchReplicaBootstrapPage(
    { baseUrl: liveBase },
    { window: 1, fetcher: fetcher() }
  );
  const gatewayId = getDesktopName() || space?.gatewayId || liveBase;
  Store.set(LAST_BASE, liveBase);
  await noteActiveIdentity({ gatewayId, vaultId: probe.vaultId });
  return {
    auth: { baseUrl: liveBase, gatewayId, vaultId: probe.vaultId },
    gatewayId,
    online: true,
  };
}

async function mountedScopes(
  identity: Awaited<ReturnType<typeof resolveIdentity>>,
  storageLocation?: string
): Promise<MountedReplicaScope[]> {
  const key = `centraid:replica-scopes:${identity.gatewayId}`;
  let scopes: ScopeWire[] | undefined;
  if (identity.online) {
    try {
      const response = await fetch(
        new URL("/centraid/_vault/scopes", identity.auth.baseUrl),
        { headers: authHeader() }
      );
      if (response.ok) {
        const body = (await response.json()) as { scopes?: ScopeWire[] };
        if (Array.isArray(body.scopes)) {
          scopes = body.scopes;
          await AsyncStorage.setItem(key, JSON.stringify(scopes));
        }
      }
    } catch {
      // Offline cache below is authoritative until the gateway returns.
    }
  }
  if (!scopes) {
    try {
      const raw = await AsyncStorage.getItem(key);
      if (raw) scopes = JSON.parse(raw) as ScopeWire[];
    } catch {
      // Fall through to the active scope.
    }
  }
  const active = identity.auth.vaultId!;
  const ordered = [
    ...(scopes ?? []).filter((scope) => scope.vaultId === active),
    ...(scopes ?? []).filter((scope) => scope.vaultId !== active),
  ];
  if (!ordered.some((scope) => scope.vaultId === active)) {
    ordered.unshift({ vaultId: active, label: "Current", role: "write" });
  }
  return Promise.all(
    ordered.slice(0, MAX_MOUNTED_NATIVE_SCOPES).map(async (scope) => ({
      ...scope,
      databaseName: await nativeReplicaDatabasePath(
        { gatewayId: identity.gatewayId, vaultId: scope.vaultId },
        nativeReplicaDigest,
        storageLocation
      ),
    }))
  );
}

function freshnessKey(gatewayId: string, vaultId: string): string {
  return `centraid:replica-freshness:${encodeURIComponent(
    `${gatewayId} ${vaultId}`
  )}`;
}

async function loadFreshness(
  gatewayId: string,
  scopes: readonly MountedReplicaScope[]
): Promise<Map<string, string>> {
  const rows = await Promise.all(
    scopes.map(
      async (scope) =>
        [
          scope.vaultId,
          await AsyncStorage.getItem(
            freshnessKey(gatewayId, scope.vaultId)
          ).catch(() => null),
        ] as const
    )
  );
  return new Map(
    rows.filter((row): row is readonly [string, string] => row[1] !== null)
  );
}

async function removeCachedScope(
  gatewayId: string,
  vaultId: string
): Promise<void> {
  const scopesKey = `centraid:replica-scopes:${gatewayId}`;
  try {
    const raw = await AsyncStorage.getItem(scopesKey);
    if (raw) {
      const scopes = JSON.parse(raw) as ScopeWire[];
      await AsyncStorage.setItem(
        scopesKey,
        JSON.stringify(scopes.filter((scope) => scope.vaultId !== vaultId))
      );
    }
  } catch {
    // A malformed optional scope cache must not retain revoked freshness.
  }
  await AsyncStorage.removeItem(freshnessKey(gatewayId, vaultId));
}

export function ReplicaProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [active, setActive] = useState<Space | undefined>();
  const activeRef = useRef<Space | undefined>(undefined);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    let unsubscribe = (): void => undefined;
    void hydrateSpaces().then(() => {
      const update = (): void => {
        const space = getActiveSpace();
        activeRef.current = space;
        setActive(space);
      };
      update();
      setHydrated(true);
      unsubscribe = subscribeSpaces(update);
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
    const looseDrivers: Array<{ close: () => void }> = [];

    void (async () => {
      try {
        const identity = await resolveIdentity(activeRef.current);
        await requireMobileOfflineGateway({
          baseUrl: identity.auth.baseUrl,
          gatewayId: identity.gatewayId,
          online: identity.online,
        });
        const storageLocation = replicaStorageDirectory();
        const scopes = await mountedScopes(identity, storageLocation);
        const freshness = await loadFreshness(identity.gatewayId, scopes);
        if (identity.online)
          void registerReplicaPushWake(identity.auth.baseUrl);
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
            if (!cancelled && pulled) {
              setBuilt((current) =>
                current?.gatewayKey === gatewayKey
                  ? {
                      gatewayKey,
                      value: {
                        ...current.value,
                        reachability: "current",
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
            reachability: connected ? "current" : "gateway-asleep",
            refresh,
          },
        });
        networkSubscription = Network.addNetworkStateListener((network) => {
          void refreshReachability(network);
        });
        void refresh();
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
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
    })();
    return () => {
      cancelled = true;
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
