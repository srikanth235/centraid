export interface PairingResponseVault {
  vaultId: string;
  enrollmentId?: string;
  vaultName?: string;
  role?: "admin" | "write" | "read";
}

export interface PairingResponseVaultFields {
  vaultId?: string;
  vaultIds?: readonly string[];
  vaults?: readonly PairingResponseVault[];
}

export function normalizePairedVaults(
  response: PairingResponseVaultFields
): PairingResponseVault[] {
  const metadata = new Map(
    (response.vaults ?? [])
      .filter(
        (vault) => typeof vault.vaultId === "string" && vault.vaultId.length > 0
      )
      .map((vault) => [vault.vaultId, vault] as const)
  );
  const ids = [
    ...(response.vaultId ? [response.vaultId] : []),
    ...(response.vaultIds ?? []),
    ...metadata.keys(),
  ].filter(
    (vaultId, index, all) =>
      typeof vaultId === "string" &&
      vaultId.length > 0 &&
      all.indexOf(vaultId) === index
  );
  return ids.map((vaultId) => metadata.get(vaultId) ?? { vaultId });
}
