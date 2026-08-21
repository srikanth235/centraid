// What Photos knows about the vaults its timeline is merged from (§H).
//
// Two vaults exist by default: the member's own, and the shared one the
// account was founded with. The tile marker is derived from the vault
// record's `personal` marker, never from its name — so this is the one place
// that reads the mounted scopes and hands Photos a map it can look a vault up
// in. A share has no destination vault to resolve here at all (#825): sharing
// a photograph records a GRANT over it, addressed to a person or a named
// circle by the grant sheet (`kit/share/GrantSheet.tsx`), and nothing about
// that names a vault this map could look up.

import { useMemo } from "react";

import { useReplica } from "../../kit/replica/ReplicaProvider";
import type { MountedReplicaScope } from "../../lib/replica/multi-vault-reader";
import type { VaultFacts } from "./tile-overlays";

/**
 * A scope the gateway answered before it carried `personal` (or an offline
 * cache written by an older build) is treated as the member's own: the
 * unmarked default is the safe answer, because marking their own photograph
 * as "somewhere other than my own vault" says something untrue, while failing
 * to mark one only withholds a hint the member can still get from the filter.
 */
export function vaultPersonalOf(scope: { personal?: boolean }): boolean {
  return scope.personal !== false;
}

export function vaultFacts(
  scopes: readonly MountedReplicaScope[] | undefined
): ReadonlyMap<string, VaultFacts> {
  return new Map(
    (scopes ?? []).map((scope) => [
      scope.vaultId,
      {
        vaultId: scope.vaultId,
        label: scope.label,
        personal: vaultPersonalOf(scope),
      },
    ])
  );
}

/**
 * The mounted vaults, as Photos needs them. A hook rather than a prop so every
 * shelf marks tiles the same way without each screen re-wiring it.
 */
export function useVaultFacts(): ReadonlyMap<string, VaultFacts> {
  const { scopes } = useReplica();
  return useMemo(() => vaultFacts(scopes), [scopes]);
}
