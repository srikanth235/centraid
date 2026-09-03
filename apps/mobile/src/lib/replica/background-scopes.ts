import { MAX_MOUNTED_NATIVE_SCOPES } from "./offline-budgets";

export interface CachedBackgroundScope {
  vaultId: string;
  label?: string;
  canWrite?: boolean;
}

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
  return ordered.slice(0, MAX_MOUNTED_NATIVE_SCOPES);
}
