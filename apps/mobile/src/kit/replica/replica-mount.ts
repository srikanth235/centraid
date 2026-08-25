// Mount policy — identity, scope selection, freshness, revocation — all
// answerable offline. `ReplicaProvider` holds only the lifecycle.

import AsyncStorage from "@react-native-async-storage/async-storage";

import { fetchReplicaBootstrapPage } from "@centraid/client/replica/native";
import type {
  GatewayAuth,
  ReplicaFetcher,
} from "@centraid/client/replica/native";

import { authHeader, resolveGatewayBase } from "../../lib/gateway";
import type { MountedReplicaScope } from "../../lib/replica/multi-vault-reader";
import { nativeReplicaDigest } from "../../lib/replica/native-hash";
import { MAX_MOUNTED_NATIVE_SCOPES } from "../../lib/replica/offline-budgets";
import { nativeReplicaDatabasePath } from "../../lib/replica/op-sqlite-driver";
import { LAST_BASE, noteActiveIdentity } from "../../lib/vault-links";
import type { VaultLink } from "../../lib/vault-links";
import { Store } from "../../storage";

export const REPLICA_UNPAIRED_MESSAGE =
  "Pair this phone with your Centraid desktop to work offline.";

/** Must match `addActiveGatewayVault`'s `"manual"` id; not shared. */
const MANUAL_GATEWAY_FALLBACK = "manual";

interface ScopeWire {
  vaultId: string;
  label: string;
  canWrite: boolean;
  /** Derive "not my vault" from this, never `label`. Older caches omit it. */
  personal?: boolean;
}

export function fetcher(vaultId?: string): ReplicaFetcher {
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

/** `undefined` on failure, so the ladder below falls through instead of taking
 *  a namespace that moves under the next launch. */
async function fetchEndpointId(baseUrl: string): Promise<string | undefined> {
  try {
    const response = await fetch(new URL("/centraid/_gateway/info", baseUrl), {
      headers: authHeader(),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { endpointId?: string };
    return body.endpointId || undefined;
  } catch {
    return undefined;
  }
}

export async function resolveIdentity(vault: VaultLink | undefined): Promise<{
  auth: GatewayAuth;
  gatewayId: string;
  online: boolean;
}> {
  const cachedBase = await Store.hydrate(LAST_BASE, "http://127.0.0.1");
  if (vault?.gatewayId && vault.vaultId) {
    const liveBase = await resolveGatewayBase().catch(() => undefined);
    if (liveBase) Store.set(LAST_BASE, liveBase);
    return {
      auth: {
        baseUrl: liveBase ?? cachedBase,
        gatewayId: vault.gatewayId,
        vaultId: vault.vaultId,
      },
      gatewayId: vault.gatewayId,
      online: liveBase !== undefined,
    };
  }
  const liveBase = await resolveGatewayBase().catch(() => undefined);
  if (!liveBase) throw new Error(REPLICA_UNPAIRED_MESSAGE);
  // Ladder: endpoint id, carried vault, literal — never the display name,
  // which demotes a durable id to a renameable one.
  const [probe, endpointId] = await Promise.all([
    fetchReplicaBootstrapPage(
      { baseUrl: liveBase },
      { window: 1, fetcher: fetcher() }
    ),
    fetchEndpointId(liveBase),
  ]);
  const gatewayId = endpointId ?? vault?.gatewayId ?? MANUAL_GATEWAY_FALLBACK;
  Store.set(LAST_BASE, liveBase);
  await noteActiveIdentity({ gatewayId, vaultId: probe.vaultId });
  return {
    auth: { baseUrl: liveBase, gatewayId, vaultId: probe.vaultId },
    gatewayId,
    online: true,
  };
}

/** Separate so an offline-mounted session primes the cache without
 *  remounting. */
export async function refreshCachedScopes(
  gatewayId: string,
  baseUrl: string
): Promise<void> {
  const key = `centraid:replica-scopes:${gatewayId}`;
  try {
    const response = await fetch(new URL("/centraid/_vault/scopes", baseUrl), {
      headers: authHeader(),
    });
    if (response.ok) {
      const body = (await response.json()) as { scopes?: ScopeWire[] };
      if (Array.isArray(body.scopes)) {
        await AsyncStorage.setItem(key, JSON.stringify(body.scopes));
      }
    }
  } catch {
    // The cache stays authoritative until the gateway answers.
  }
}

/** Refresh BEFORE the read, never instead of it. A scope granted mid-session
 *  mounts only on the next launch. */
export async function mountedScopes(
  identity: Awaited<ReturnType<typeof resolveIdentity>>,
  storageLocation?: string
): Promise<MountedReplicaScope[]> {
  const key = `centraid:replica-scopes:${identity.gatewayId}`;
  if (identity.online) {
    await refreshCachedScopes(identity.gatewayId, identity.auth.baseUrl);
  }
  let scopes: ScopeWire[] | undefined;
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw) scopes = JSON.parse(raw) as ScopeWire[];
  } catch {
    // Fall through to the active scope.
  }
  const active = identity.auth.vaultId!;
  const ordered = [
    ...(scopes ?? []).filter((scope) => scope.vaultId === active),
    ...(scopes ?? []).filter((scope) => scope.vaultId !== active),
  ];
  if (!ordered.some((scope) => scope.vaultId === active)) {
    ordered.unshift({ vaultId: active, label: "Current", canWrite: true });
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

export function freshnessKey(gatewayId: string, vaultId: string): string {
  return `centraid:replica-freshness:${encodeURIComponent(
    `${gatewayId} ${vaultId}`
  )}`;
}

export async function loadFreshness(
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

export async function removeCachedScope(
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
    // A malformed cache must not retain revoked freshness.
  }
  await AsyncStorage.removeItem(freshnessKey(gatewayId, vaultId));
}
