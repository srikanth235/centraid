/**
 * Normalize the gateway's pairing response for device-local vault storage.
 *
 * `vaultId` is the primary landing vault. New gateways also return `vaultIds`
 * and per-vault metadata; older gateways may return only the primary field.
 * The response is presentation data after the gateway has already authorized
 * and enrolled the device, so this helper only preserves order and removes
 * duplicates—it never grants access locally.
 */
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
    // COMPAT(pair-ticket-multi-vault): added 2026-08-02, drop when floor >= pair-ticket-multi-vault-v1
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
