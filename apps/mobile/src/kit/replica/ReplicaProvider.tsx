import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import * as Network from 'expo-network';
import {
  fetchReplicaBootstrapPage,
  type GatewayAuth,
  type ReplicaFetcher,
} from '@centraid/client/replica/native';

import { authHeader, resolveGatewayBase } from '../../lib/gateway';
import { getDesktopName } from '../../lib/phone-link';
import { NativeVaultChangeFeed } from '../../lib/replica/native-change-feed';
import { nativeReplicaDigest } from '../../lib/replica/native-hash';
import { openNativeReplicaDriver } from '../../lib/replica/op-sqlite-driver';
import {
  createNativeReplicaSession,
  type NativeReplicaSession,
} from '../../lib/replica/native-session';
import { Store } from '../../storage';

const LAST_GATEWAY = 'replica.lastGateway';
const LAST_VAULT = 'replica.lastVault';
const LAST_BASE = 'replica.lastBase';

interface ReplicaContextValue {
  session?: NativeReplicaSession;
  gatewayBase?: string;
  vaultId?: string;
  ready: boolean;
  online: boolean;
  error?: string;
}

const ReplicaContext = createContext<ReplicaContextValue>({ ready: false, online: false });

function fetcher(vaultId?: string): ReplicaFetcher {
  return async (baseUrl, pathname, init) => {
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(authHeader())) headers.set(key, value);
    if (vaultId) headers.set('x-centraid-vault', vaultId);
    return fetch(new URL(pathname, `${baseUrl}/`), { ...init, headers } as RequestInit);
  };
}

async function resolveIdentity(): Promise<{
  auth: GatewayAuth;
  gatewayId: string;
  online: boolean;
}> {
  // A paired device opens its local SQLite identity first. Network discovery
  // is only a first-pair bootstrap, never a prerequisite for native reads.
  const [cachedGatewayId, cachedVaultId, cachedBase] = await Promise.all([
    Store.hydrate(LAST_GATEWAY, ''),
    Store.hydrate(LAST_VAULT, ''),
    Store.hydrate(LAST_BASE, 'http://127.0.0.1'),
  ]);
  if (cachedGatewayId && cachedVaultId) {
    // The loopback port belongs to a particular tunnel process. Always ask
    // phone-link to restart/resolve it after boot; the cached URL is only an
    // offline placeholder for opening the local replica.
    const liveBase = await resolveGatewayBase().catch(() => undefined);
    if (liveBase) Store.set(LAST_BASE, liveBase);
    return {
      auth: {
        baseUrl: liveBase ?? cachedBase,
        gatewayId: cachedGatewayId,
        vaultId: cachedVaultId,
      },
      gatewayId: cachedGatewayId,
      online: liveBase !== undefined,
    };
  }

  const liveBase = await resolveGatewayBase().catch(() => undefined);
  if (liveBase) {
    const probe = await fetchReplicaBootstrapPage(
      { baseUrl: liveBase },
      { window: 1, fetcher: fetcher() },
    );
    const gatewayId = getDesktopName() || liveBase;
    Store.set(LAST_GATEWAY, gatewayId);
    Store.set(LAST_VAULT, probe.vaultId);
    Store.set(LAST_BASE, liveBase);
    return {
      auth: { baseUrl: liveBase, gatewayId, vaultId: probe.vaultId },
      gatewayId,
      online: true,
    };
  }

  throw new Error('Pair a desktop once to create the local replica.');
}

export function ReplicaProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [value, setValue] = useState<ReplicaContextValue>({ ready: false, online: false });

  useEffect(() => {
    let cancelled = false;
    let session: NativeReplicaSession | undefined;
    let networkSubscription: { remove(): void } | undefined;
    void (async () => {
      try {
        const identity = await resolveIdentity();
        const driver = await openNativeReplicaDriver(
          { gatewayId: identity.gatewayId, vaultId: identity.auth.vaultId! },
          nativeReplicaDigest,
        );
        const changeFeed = new NativeVaultChangeFeed({
          gatewayAuth: identity.auth,
          storage: AsyncStorage,
        });
        let connected = identity.online;
        session = await createNativeReplicaSession({
          gatewayAuth: identity.auth,
          fetcher: fetcher(identity.auth.vaultId),
          changeFeed,
          driver,
          appState: AppState,
          isConnected: () => connected,
          bootstrapWindow: 5_000,
        });
        if (cancelled) {
          await session.close();
          return;
        }
        setValue({
          session,
          gatewayBase: identity.auth.baseUrl,
          vaultId: identity.auth.vaultId,
          ready: true,
          online: identity.online,
        });
        const refreshReachability = async (network: Network.NetworkState): Promise<void> => {
          const liveBase =
            network.isConnected === true
              ? await resolveGatewayBase().catch(() => undefined)
              : undefined;
          if (cancelled) return;
          connected = liveBase !== undefined;
          if (liveBase) {
            Store.set(LAST_BASE, liveBase);
            session?.updateGatewayBase(liveBase);
            session?.notifyReachable();
          }
          setValue((current) => ({
            ...current,
            ...(liveBase ? { gatewayBase: liveBase } : {}),
            online: connected,
          }));
        };
        networkSubscription = Network.addNetworkStateListener((network) => {
          void refreshReachability(network);
        });
        void Network.getNetworkStateAsync().then(refreshReachability);
      } catch (error) {
        if (!cancelled) {
          setValue({
            ready: true,
            online: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      networkSubscription?.remove();
      void session?.close();
    };
  }, []);

  const stable = useMemo(() => value, [value]);
  return <ReplicaContext.Provider value={stable}>{children}</ReplicaContext.Provider>;
}

export function useReplica(): ReplicaContextValue {
  return useContext(ReplicaContext);
}
