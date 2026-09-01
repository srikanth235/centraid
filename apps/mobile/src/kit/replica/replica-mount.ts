// Mount policy — identity, scope selection, freshness, revocation — all
// answerable offline. `ReplicaProvider` holds only the lifecycle.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { File } from "expo-file-system";

import { fetchReplicaBootstrapPage } from "@centraid/client/replica/native";
import type {
  GatewayAuth,
  ReplicaFetcher,
} from "@centraid/client/replica/native";

import { authHeader, resolveGatewayBase } from "../../lib/gateway";
import { fetchWithinReplyDeadline } from "../../lib/replica/gateway-deadline";
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
    const url = new URL(pathname, `${baseUrl}/`);
    // Deadlined: the tunnel accepts after its peer is gone (#903).
    return fetchWithinReplyDeadline(
      (signal) => fetch(url, { ...init, headers, signal } as RequestInit),
      init.signal ?? undefined
    );
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
 *  reaches the mounted four only when the provider re-plans the mount —
 *  activating it does that; otherwise it waits for the next launch. */
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

/** Must match `NativeVaultChangeFeed`'s and `NativeMultiplexChangeFeed`'s own
 *  private key builders; neither is exported, and both are owned elsewhere. */
function restoredCacheKeys(gatewayId: string, vaultId: string): string[] {
  const suffix = encodeURIComponent(`${gatewayId} ${vaultId}`);
  return [
    freshnessKey(gatewayId, vaultId),
    `centraid:multiplex-cursor:${suffix}`,
    `centraid:vault-change-cursor:${suffix}`,
  ];
}

/** An absent or zero-byte database is a container this replica never wrote. */
function replicaFileHasData(databaseName: string): boolean {
  try {
    const file = new File(databaseName);
    return file.exists && (file.size ?? 0) > 0;
  } catch {
    // An unreadable path is not evidence of a restore; keep the cursor.
    return true;
  }
}

/**
 * Drop cursors and stamps a restored container inherited (#880).
 *
 * The replica databases sit in the module-owned durable directory and never
 * ride Auto Backup, D2D transfer, or an iCloud restore. The SSE resume cursors
 * and freshness stamps beside them are ordinary app storage, so a restored
 * device wakes up holding another phone's cursor over an empty replica: the
 * feed resumes at a sequence for rows this device never had and every change
 * before it is missing without a word. The Android manifest excludes that store
 * outright; this is the same rule enforced from inside the app, which is also
 * where an iOS restore and any future backup-rule change pass.
 *
 * Returns the vaults whose cache was discarded, so bootstrap starts clean.
 */
export async function discardRestoredReplicaCache(
  gatewayId: string,
  scopes: readonly MountedReplicaScope[],
  hasReplicaData: (databaseName: string) => boolean = replicaFileHasData
): Promise<string[]> {
  const cleared = await Promise.all(
    scopes.map(async (scope) => {
      if (hasReplicaData(scope.databaseName)) return undefined;
      const keys = restoredCacheKeys(gatewayId, scope.vaultId);
      const cached = await Promise.all(
        keys.map((key) => AsyncStorage.getItem(key).catch(() => null))
      );
      // A first launch after pairing has no database and no cache either —
      // that is a cold start, not a restore, and it must stay silent.
      if (cached.every((value) => value === null)) return undefined;
      await Promise.all(
        keys.map((key) => AsyncStorage.removeItem(key).catch(() => undefined))
      );
      return scope.vaultId;
    })
  );
  return cleared.filter((vaultId): vaultId is string => vaultId !== undefined);
}

/** Live SQLite family: the main file plus every rollback/WAL sidecar. */
const SQLITE_SIDECARS = ["-journal", "-wal", "-shm"] as const;

export function replicaDatabaseFamily(databaseName: string): string[] {
  return [
    databaseName,
    ...SQLITE_SIDECARS.map((suffix) => `${databaseName}${suffix}`),
  ];
}

/**
 * Reclaim one revoked scope's bytes.
 *
 * A purge empties the tables in place, so the file stays at full size for a
 * vault this phone may never see again. Only a REVOKED scope reaches here: a
 * vault merely evicted by the four-scope cap is still enrolled and its replica
 * is an asset, not garbage. A bare database name means op-sqlite's own default
 * location, which this module cannot address — the storage screen reports those
 * bytes rather than this deleting the wrong file.
 */
export function deleteReplicaDatabaseFamily(databaseName: string): void {
  if (!databaseName.includes("/")) return;
  for (const path of replicaDatabaseFamily(databaseName)) {
    try {
      const file = new File(path);
      if (file.exists) file.delete();
    } catch {
      // A sidecar the OS already removed is the outcome asked for.
    }
  }
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
