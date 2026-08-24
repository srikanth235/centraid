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

/**
 * Fallback replica namespace when a probe's gateway reports no endpoint id
 * (an older gateway, or a read that failed) and nothing else names one. Kept
 * as a local literal rather than reaching into lib/vault-links for it: the
 * value has to match `addActiveGatewayVault`'s own `"manual"` gateway id
 * there (a device with no active VaultLink gets the same namespace either
 * way), but that is a coincidence of the two fallbacks meaning the same
 * thing, not a shared constant either module is required to keep exporting.
 */
const MANUAL_GATEWAY_FALLBACK = "manual";

interface ScopeWire {
  vaultId: string;
  label: string;
  canWrite: boolean;
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

/**
 * The gateway's own durable EndpointId, straight off `/centraid/_gateway/info`.
 * `undefined` on any failure — bad response, no body, an old gateway that
 * omits the field — so the ladder in `resolveIdentity` can fall through
 * rather than adopt a namespace that will move under the next launch.
 */
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
  // THE FIRST BOOTSTRAP AFTER PAIRING lands here: pairing stores a real
  // gateway id with `vaultId: ""` for this probe to fill in. The ladder below
  // prefers the gateway's OWN reported endpoint id — the durable fact — over
  // the vault we were already carrying, and only falls to a stable literal
  // when the gateway cannot report one at all. It never asks the desktop's
  // display name: that would demote a durable endpoint id to whatever the
  // desktop happens to be called at that moment and write it back through
  // `noteActiveIdentity`.
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

/**
 * Fetch this gateway's enrolled scopes and refresh the offline cache that
 * `mountedScopes` reads. Split out of `mountedScopes` so a LIVE session — one
 * that mounted offline (see mount-plan.ts) and only later hears the gateway
 * answer, in `ReplicaProvider`'s `refreshReachability` pass — can prime the
 * cache too, without remounting anything. Network errors are swallowed: the
 * offline cache stays authoritative until the gateway returns, same as before
 * this was split out.
 */
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
    // Offline cache below is authoritative until the gateway returns.
  }
}

/**
 * The scopes this device mounts, in active-first order.
 *
 * Refreshing the cache (when online) happens BEFORE reading it, never
 * instead of reading it — every path, online or not, reads the same
 * AsyncStorage cache, so the ordering/fallback logic below only has one
 * source to reason about. This carries a one-launch lag by design: a scope
 * granted while the app is already mounted lands in the cache via
 * `refreshCachedScopes` (phase B, `refreshReachability`) but only mounts a
 * replica database for it on the NEXT launch, when this function runs again.
 */
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
