import AsyncStorage from "@react-native-async-storage/async-storage";
import { File } from "expo-file-system";

import { fetchReplicaBootstrapPage } from "@centraid/client/replica/native";
import type {
  GatewayAuth,
  ReplicaFetcher,
} from "@centraid/client/replica/native";

import { pathToFileUri } from "../../../modules/centraid-storage";
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

const MANUAL_GATEWAY_FALLBACK = "manual";

interface ScopeWire {
  vaultId: string;
  label: string;
  canWrite: boolean;
  personal?: boolean;
}

export function fetcher(vaultId?: string): ReplicaFetcher {
  return async (baseUrl, pathname, init) => {
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(authHeader()))
      headers.set(key, value);
    if (vaultId) headers.set("x-centraid-vault", vaultId);
    const method = init.method ?? "GET";
    const url = new URL(pathname, `${baseUrl}/`);
    try {
      const response = await fetchWithinReplyDeadline(
        (signal) => fetch(url, { ...init, headers, signal } as RequestInit),
        init.signal ?? undefined
      );
      if (!response.ok)
        console.error(
          `[centraid] replica: ${method} ${pathname} -> ${response.status}`
        );
      return response;
    } catch (error) {
      console.error(
        `[centraid] replica: ${method} ${pathname} never left the phone — ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  };
}

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
    // Intentionally empty.
  }
}

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
    // Intentionally empty.
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

function restoredCacheKeys(gatewayId: string, vaultId: string): string[] {
  const suffix = encodeURIComponent(`${gatewayId} ${vaultId}`);
  return [
    freshnessKey(gatewayId, vaultId),
    `centraid:multiplex-cursor:${suffix}`,
    `centraid:vault-change-cursor:${suffix}`,
  ];
}

function replicaFileHasData(databaseName: string): boolean {
  try {
    const file = new File(pathToFileUri(databaseName));
    return file.exists && (file.size ?? 0) > 0;
  } catch {
    return true;
  }
}

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
      if (cached.every((value) => value === null)) return undefined;
      await Promise.all(
        keys.map((key) => AsyncStorage.removeItem(key).catch(() => undefined))
      );
      return scope.vaultId;
    })
  );
  return cleared.filter((vaultId): vaultId is string => vaultId !== undefined);
}

const SQLITE_SIDECARS = ["-journal", "-wal", "-shm"] as const;

export function replicaDatabaseFamily(databaseName: string): string[] {
  return [
    databaseName,
    ...SQLITE_SIDECARS.map((suffix) => `${databaseName}${suffix}`),
  ];
}

export function deleteReplicaDatabaseFamily(databaseName: string): void {
  if (!databaseName.includes("/")) return;
  for (const path of replicaDatabaseFamily(databaseName)) {
    try {
      const file = new File(pathToFileUri(path));
      if (file.exists) file.delete();
    } catch {
      // Intentionally empty.
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
    // Intentionally empty.
  }
  await AsyncStorage.removeItem(freshnessKey(gatewayId, vaultId));
}
