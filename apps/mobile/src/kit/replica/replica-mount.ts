// How the phone decides *what* to mount before `ReplicaProvider` mounts it.
//
// Four questions, all of which have an offline answer and none of which is React:
// which gateway and vault this device is addressing, which enrolled scopes make
// the four-scope cut, when each of those last successfully pulled, and what to
// forget when one is revoked. Kept beside the provider rather than inside it so
// the provider file is the lifecycle and this file is the policy.

import AsyncStorage from "@react-native-async-storage/async-storage";

import { fetchReplicaBootstrapPage } from "@centraid/client/replica/native";
import type {
  GatewayAuth,
  ReplicaFetcher,
} from "@centraid/client/replica/native";

import { authHeader, resolveGatewayBase } from "../../lib/gateway";
import { getDesktopName } from "../../lib/phone-link";
import type { MountedReplicaScope } from "../../lib/replica/multi-vault-reader";
import { nativeReplicaDigest } from "../../lib/replica/native-hash";
import { MAX_MOUNTED_NATIVE_SCOPES } from "../../lib/replica/offline-budgets";
import { nativeReplicaDatabasePath } from "../../lib/replica/op-sqlite-driver";
import { LAST_BASE, noteActiveIdentity } from "../../lib/vault-links";
import type { VaultLink } from "../../lib/vault-links";
import { Store } from "../../storage";

/** Copy the pairing wall shows; also the error a missing gateway throws. */
export const REPLICA_UNPAIRED_MESSAGE =
  "Pair this phone with your Centraid desktop to work offline.";

interface ScopeWire {
  vaultId: string;
  label: string;
  role: "admin" | "write" | "read";
  /**
   * Whether this is the member's OWN vault — what the vault *is*, which is not
   * what it is called. Apps derive the "somewhere other than my own vault"
   * marker from this and never from `label`: a member who names their own
   * vault "Sharing" has not shared anything. The gateway sends it on every
   * scope row (`ScopeRow.personal` in `scopes-routes.ts`); the phone used to
   * drop it.
   *
   * Optional because a scope cached by an older build, or the synthesised
   * fallback below, genuinely does not know.
   */
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
  const probe = await fetchReplicaBootstrapPage(
    { baseUrl: liveBase },
    { window: 1, fetcher: fetcher() }
  );
  const gatewayId = getDesktopName() || vault?.gatewayId || liveBase;
  Store.set(LAST_BASE, liveBase);
  await noteActiveIdentity({ gatewayId, vaultId: probe.vaultId });
  return {
    auth: { baseUrl: liveBase, gatewayId, vaultId: probe.vaultId },
    gatewayId,
    online: true,
  };
}

export async function mountedScopes(
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

/** Where one `(gateway, vault)` pair's last-successful-pull stamp is stored. */
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
    // A malformed optional scope cache must not retain revoked freshness.
  }
  await AsyncStorage.removeItem(freshnessKey(gatewayId, vaultId));
}
