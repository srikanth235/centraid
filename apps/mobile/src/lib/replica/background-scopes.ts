import { MAX_BACKGROUND_FEED_MOUNTS } from "./offline-budgets";

export interface CachedBackgroundScope {
  vaultId: string;
  label?: string;
  canWrite?: boolean;
}

/** The focused write target always survives the background feed cap. */
export function selectBackgroundScopes(
  scopes: readonly CachedBackgroundScope[],
  activeVaultId: string
): CachedBackgroundScope[] {
  const ordered = [
    ...scopes.filter((scope) => scope.vaultId === activeVaultId),
    ...scopes.filter((scope) => scope.vaultId !== activeVaultId),
  ];
  if (!ordered.some((scope) => scope.vaultId === activeVaultId))
    ordered.unshift({ vaultId: activeVaultId });
  return ordered.slice(0, MAX_BACKGROUND_FEED_MOUNTS);
}
