// Which scopes an inline app mounts over (issue #599).
//
// A member holds a role in their own vault and in every audience vault the
// household added them to. `GET /_vault/scopes?app=<id>` answers that set for
// the CALLING MEMBER (roles come from `member_roles`, never from the device),
// already filtered to mounted vaults and already reconciled — the gateway
// installs the app into an audience the member joined but never opened.
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

import { auth } from '../../../gateway-client-core.js';
import { listAppScopes, type AppScopeEntry } from '../../../gateway-client-vault.js';
import {
  addressedGatewayAuth,
  replicaIdentityForGatewayAuth,
} from '../../../replica/shell-session.js';
import type { ReplicaIdentity } from '../../../replica/types.js';
import type { InlineScope } from '@centraid/blueprints/apps/inline-types';
import { useAsyncData, type AsyncState } from '../useAsyncData.js';

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

/** Mirrors the gateway's `canWrite` — admin is write's superset. */
function roleCanWrite(role: string): boolean {
  return role === 'admin' || role === 'write';
}

function toResolved(entry: AppScopeEntry, gatewayId: string): ResolvedAppScope {
  return {
    scope: {
      id: entry.vaultId,
      label: entry.label,
      ...(entry.color ? { color: entry.color } : {}),
      ...(entry.icon ? { icon: entry.icon } : {}),
      canWrite: roleCanWrite(entry.role),
    },
    identity: { gatewayId, vaultId: entry.vaultId },
  };
}

/** The single-scope answer: whatever the shell is focused on right now. */
async function ambientScope(): Promise<ResolvedAppScope[]> {
  const gatewayAuth = await addressedGatewayAuth();
  const identity = replicaIdentityForGatewayAuth(gatewayAuth);
  return [{ scope: { id: identity.vaultId, label: 'Library', canWrite: true }, identity }];
}

/**
 * Resolve the scope set for one app. Never rejects for a reason the shell can
 * absorb: a gateway without the plane, or a transient failure, degrades to the
 * ambient scope so the app still mounts.
 */
export async function resolveAppScopes(appId: string): Promise<ResolvedAppScope[]> {
  let entries: AppScopeEntry[] | undefined;
  try {
    entries = await listAppScopes(appId);
  } catch {
    entries = undefined;
  }
  // Only scopes the app is actually installed in are mountable: a replica
  // session for a vault with no enrolment for this app has no shapes to read,
  // so it would surface as a permanently-failing audience. The gateway already
  // auto-installs where it can, so anything still false here genuinely is not
  // available. `undefined` means the gateway did not answer the question and is
  // taken at face value.
  const mountable = (entries ?? []).filter((entry) => entry.installed !== false);
  if (mountable.length === 0) return ambientScope();
  const base = await auth();
  const gatewayId = replicaIdentityForGatewayAuth({
    ...base,
    vaultId: mountable[0]!.vaultId,
  }).gatewayId;
  const resolved = mountable.map((entry) => toResolved(entry, gatewayId));
  return resolved.slice(0, MAX_MOUNTED_SCOPES);
}

/** A stable identity for one scope SET — the mount key's new axis. */
export function scopeSetKey(scopes: readonly ResolvedAppScope[]): string {
  return scopes
    .map((entry) => entry.identity.vaultId)
    .sort()
    .join(',');
}

/**
 * One in-flight/settled resolve per app, so re-entering an app does not pay the
 * round-trip again — the scope set gates first paint, and it changes only when
 * the household does. Dropped wholesale when the gateway flips, because both
 * the roster and the credentials behind it belong to that gateway.
 */
const resolved = new Map<string, Promise<ResolvedAppScope[]>>();
window.CentraidApi?.onGatewayChanged?.(() => resolved.clear());

export function useAppScopes(appId: string): AsyncState<ResolvedAppScope[]> {
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
