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
import {
  LAST_BASE,
  getActiveSpace,
  hydrateSpaces,
  noteActiveIdentity,
  subscribeSpaces,
} from '../../lib/spaces';
import { Store } from '../../storage';

// Thrown when the device has never been paired (no cached gateway/vault and no
// live base). This is an expected first-run state, not a failure — the Home
// screen already invites pairing — so the error banner suppresses it by identity
// rather than showing an alarming red bar. Exported as the single source of truth.
export const REPLICA_UNPAIRED_MESSAGE = 'Pair a desktop once to create the local replica.';

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
  // The active Space is the source of truth for (gatewayId, vaultId) — reading
  // it in-memory (not re-hydrating LAST_* from AsyncStorage) avoids a race where
  // a just-projected slot hasn't flushed to disk yet. Network discovery is only
  // a first-pair bootstrap, never a prerequisite for native reads.
  await hydrateSpaces();
  const active = getActiveSpace();
  const cachedBase = await Store.hydrate(LAST_BASE, 'http://127.0.0.1');

  if (active && active.gatewayId && active.vaultId) {
    // A fully-resolved tuple: open the local SQLite replica immediately. The
    // loopback port belongs to a particular tunnel process, so always ask
    // phone-link to restart/resolve the live base; the cached URL is only an
    // offline placeholder for opening the local replica.
    const liveBase = await resolveGatewayBase().catch(() => undefined);
    if (liveBase) Store.set(LAST_BASE, liveBase);
    return {
      auth: {
        baseUrl: liveBase ?? cachedBase,
        gatewayId: active.gatewayId,
        vaultId: active.vaultId,
      },
      gatewayId: active.gatewayId,
      online: liveBase !== undefined,
    };
  }

  // A provisional Space (freshly paired, vault not yet known) or none at all:
  // the enrolled vault must be probed over the network.
  const liveBase = await resolveGatewayBase().catch(() => undefined);
  if (liveBase) {
    const probe = await fetchReplicaBootstrapPage(
      { baseUrl: liveBase },
      { window: 1, fetcher: fetcher() },
    );
    const gatewayId = getDesktopName() || active?.gatewayId || liveBase;
    Store.set(LAST_BASE, liveBase);
    // Fill the active Space's (gatewayId, vaultId) in so the switcher shows it
    // and the next open takes the fast path above. No-op if there is no Space
    // (manual-URL dev with nothing added), which simply won't persist a tuple.
    await noteActiveIdentity({ gatewayId, vaultId: probe.vaultId });
    return {
      auth: { baseUrl: liveBase, gatewayId, vaultId: probe.vaultId },
      gatewayId,
      online: true,
    };
  }

  throw new Error(REPLICA_UNPAIRED_MESSAGE);
}

export function ReplicaProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [value, setValue] = useState<ReplicaContextValue>({ ready: false, online: false });

  // Re-key the replica when the user switches the active Space. Keyed on the
  // active Space *id*: switching / forgetting / pairing changes the id, tearing
  // down the session and rebuilding it on the new (gateway, vault). Filling in a
  // provisional Space's vault keeps the same id, so it does NOT force an extra
  // rebuild — the in-flight init already resolved that vault. `undefined` means
  // "not read yet"; the main effect waits for it so mount builds exactly once.
  const [activeSpaceId, setActiveSpaceId] = useState<string | undefined>(undefined);
  useEffect(() => {
    let unsubscribe = (): void => {};
    void hydrateSpaces().then(() => {
      setActiveSpaceId(getActiveSpace()?.id ?? '');
      unsubscribe = subscribeSpaces(() => setActiveSpaceId(getActiveSpace()?.id ?? ''));
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (activeSpaceId === undefined) return undefined; // wait for the first Space read
    // A switch: drop back to a loading state so consumers don't read the old
    // vault's session while the new one opens.
    setValue({ ready: false, online: false });
    let cancelled = false;
    let session: NativeReplicaSession | undefined;
    // Held so an unmount landing in the window between opening the op-sqlite
    // driver and creating the session (which then owns it) still releases the
    // native handle and change-feed stream instead of leaking them.
    let driver: Awaited<ReturnType<typeof openNativeReplicaDriver>> | undefined;
    let changeFeed: NativeVaultChangeFeed | undefined;
    let networkSubscription: { remove(): void } | undefined;
    void (async () => {
      try {
        const identity = await resolveIdentity();
        driver = await openNativeReplicaDriver(
          { gatewayId: identity.gatewayId, vaultId: identity.auth.vaultId! },
          nativeReplicaDigest,
        );
        if (cancelled) return;
        changeFeed = new NativeVaultChangeFeed({
          gatewayAuth: identity.auth,
          storage: AsyncStorage,
        });
        if (cancelled) return;
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
        // The session now owns the driver + feed lifecycle; hand off so the
        // cleanup below closes them only via `session.close()`.
        driver = undefined;
        changeFeed = undefined;
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
      // Session was never created: release the pieces it would have owned.
      changeFeed?.setActive(false);
      driver?.close();
    };
  }, [activeSpaceId]);

  const stable = useMemo(() => value, [value]);
  return <ReplicaContext.Provider value={stable}>{children}</ReplicaContext.Provider>;
}

export function useReplica(): ReplicaContextValue {
  return useContext(ReplicaContext);
}
