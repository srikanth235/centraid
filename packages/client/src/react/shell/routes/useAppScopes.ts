// Which scopes an inline app mounts over (issue #599).
//
// An owner owns their own vault and every audience vault the household added
// them to (#726: ownership, not a role). `GET /_vault/scopes?app=<id>`
// answers that set for the CALLING OWNER, already filtered to mounted vaults
// and already reconciled — the gateway installs the app into an audience the
// owner joined but never opened.
//
// Two deliberate limits live here rather than in the route host:
//
//   * a hard cap on hydrated scopes. Each scope costs one replica session, one
//     OPFS/SAH pool and one SSE stream, so an unbounded household would open an
//     unbounded number of them. The cap keeps the primary scope plus the first
//     few audiences; the rest are reachable when scope-switching hydrates on
//     demand.
//   * a fall back to the single ambient scope when the gateway has no scopes
//     plane (404) or the call fails. An older gateway must keep working exactly
//     as it did before this issue.

import type { InlineScope } from "@centraid/blueprints/apps/inline-types";

import { auth } from "../../../gateway-client-core.js";
import { readAppScopePlane } from "../../../gateway-client-vault.js";
import type {
  AppScopeEntry,
  AppScopePlane,
} from "../../../gateway-client-vault.js";
import {
  addressedGatewayAuth,
  replicaIdentityForGatewayAuth,
} from "../../../replica/shell-session.js";
import type { ReplicaIdentity } from "../../../replica/types.js";
import { useAsyncData } from "../useAsyncData.js";
import type { AsyncState } from "../useAsyncData.js";

/**
 * The ceiling on concurrently hydrated scopes. Four is the measured comfort
 * point for the web replica (one SAH pool + one SSE stream each); raising it is
 * a resource decision, not a correctness one.
 */
export const MAX_MOUNTED_SCOPES = 4;

/** One mountable scope: what the app is told, and what the shell opens. */
export interface ResolvedAppScope {
  scope: InlineScope;
  identity: ReplicaIdentity;
}

/** The whole mount: every scope this app is installed in and open over. */
export interface ResolvedAppScopes {
  scopes: ResolvedAppScope[];
}

function toResolved(entry: AppScopeEntry, gatewayId: string): ResolvedAppScope {
  return {
    scope: {
      id: entry.vaultId,
      label: entry.label,
      // Carried through EXACTLY as the gateway answered: an app's "somewhere
      // other than my own" marker is `personal === false`, so an older
      // gateway that omits it leaves every scope unmarked rather than marking
      // every scope (issue #711 item H).
      ...(entry.personal === undefined ? {} : { personal: entry.personal }),
      ...(entry.color ? { color: entry.color } : {}),
      ...(entry.icon ? { icon: entry.icon } : {}),
      // Ownership-sourced (#726): supplied by the gateway, never derived
      // client-side from a role.
      canWrite: entry.canWrite,
    },
    identity: { gatewayId, vaultId: entry.vaultId },
  };
}

/** The single-scope answer: whatever the shell is focused on right now. */
async function ambientScope(): Promise<ResolvedAppScopes> {
  const gatewayAuth = await addressedGatewayAuth();
  const identity = replicaIdentityForGatewayAuth(gatewayAuth);
  return {
    scopes: [
      {
        // The solo mount IS the member's own library — `personal: true`, so
        // nothing in it is marked as somewhere else.
        scope: {
          id: identity.vaultId,
          label: "Library",
          personal: true,
          canWrite: true,
        },
        identity,
      },
    ],
  };
}

/**
 * Resolve the scope set for one app. Never rejects for a reason the shell can
 * absorb: a gateway without the plane, or a transient failure, degrades to the
 * ambient scope so the app still mounts.
 */
export async function resolveAppScopes(
  appId: string
): Promise<ResolvedAppScopes> {
  let plane: AppScopePlane | undefined;
  try {
    plane = await readAppScopePlane(appId);
  } catch {
    plane = undefined;
  }
  const entries = plane?.scopes;
  // Only scopes the app is actually installed in are mountable: a replica
  // session for a vault with no enrolment for this app has no shapes to read,
  // so it would surface as a permanently-failing audience. The gateway already
  // auto-installs where it can, so anything still false here genuinely is not
  // available. `undefined` means the gateway did not answer the question and is
  // taken at face value.
  const mountable = (entries ?? []).filter(
    (entry) => entry.installed !== false
  );
  if (mountable.length === 0) return ambientScope();
  const base = await auth();
  const gatewayId = replicaIdentityForGatewayAuth({
    ...base,
    vaultId: mountable[0]!.vaultId,
  }).gatewayId;
  const resolved = mountable.map((entry) => toResolved(entry, gatewayId));
  return { scopes: resolved.slice(0, MAX_MOUNTED_SCOPES) };
}

/** A stable identity for one scope SET — the mount key's new axis. */
export function scopeSetKey(scopes: readonly ResolvedAppScope[]): string {
  return scopes
    .map((entry) => entry.identity.vaultId)
    .sort()
    .join(",");
}

/**
 * One in-flight/settled resolve per app, so re-entering an app does not pay the
 * round-trip again — the scope set gates first paint, and it changes only when
 * the household does. Dropped wholesale when the gateway flips, because both
 * the roster and the credentials behind it belong to that gateway.
 */
const resolved = new Map<string, Promise<ResolvedAppScopes>>();
window.CentraidApi?.onGatewayChanged?.(() => resolved.clear());

export function useAppScopes(appId: string): AsyncState<ResolvedAppScopes> {
  return useAsyncData(() => {
    let pending = resolved.get(appId);
    if (!pending) {
      pending = resolveAppScopes(appId);
      resolved.set(appId, pending);
      pending.catch(() => resolved.delete(appId));
    }
    return pending;
  }, [appId]);
}
