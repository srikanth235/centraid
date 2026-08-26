import { useMemo } from "react";

import { useReplica } from "../../kit/replica/ReplicaProvider";
import type { MountedReplicaScope } from "../../lib/replica/multi-vault-reader";
import type { VaultFacts } from "./tile-overlays";

/** Pre-`personal` scopes are the member's own (safe default); shares name
 * no vault (#825) — sharing records a GRANT. */
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

export function useVaultFacts(): ReadonlyMap<string, VaultFacts> {
  const { scopes } = useReplica();
  return useMemo(() => vaultFacts(scopes), [scopes]);
}
