// Inline-app scopes (#599). Owner + household audiences (#726). Cap hydrated
// scopes (each = replica session + SAH + SSE). 404/failure → ambient scope.

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

/** Concurrent hydrate cap. Raising it is a resource decision, not correctness. */
export const MAX_MOUNTED_SCOPES = 4;

export interface ResolvedAppScope {
  scope: InlineScope;
  identity: ReplicaIdentity;
}

export interface ResolvedAppScopes {
  scopes: ResolvedAppScope[];
}

function toResolved(entry: AppScopeEntry, gatewayId: string): ResolvedAppScope {
  return {
    scope: {
      id: entry.vaultId,
      label: entry.label,
      // Pass through as answered: omit ≠ false, or every scope looks foreign (#711).
      ...(entry.personal === undefined ? {} : { personal: entry.personal }),
      ...(entry.color ? { color: entry.color } : {}),
      ...(entry.icon ? { icon: entry.icon } : {}),
      // Gateway-sourced (#726) — never derived client-side from a role.
      canWrite: entry.canWrite,
    },
    identity: { gatewayId, vaultId: entry.vaultId },
  };
}

async function ambientScope(): Promise<ResolvedAppScopes> {
  const gatewayAuth = await addressedGatewayAuth();
  const identity = replicaIdentityForGatewayAuth(gatewayAuth);
  return {
    scopes: [
      {
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
  // `installed === false` is unmountable; `undefined` means the gateway did
  // not answer — take it at face value (a no-enrolment replica would hang).
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

export function scopeSetKey(scopes: readonly ResolvedAppScope[]): string {
  return scopes
    .map((entry) => entry.identity.vaultId)
    .sort()
    .join(",");
}

/** One resolve per app; drop wholesale on gateway flip (roster + credentials). */
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
