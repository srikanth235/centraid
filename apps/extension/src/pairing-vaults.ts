import type { CompanionVault } from "./types.js";

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function roleField(value: unknown): CompanionVault["role"] {
  return value === "admin" || value === "write" || value === "read"
    ? value
    : undefined;
}

/**
 * Fold a pairing response into ordered, device-local vault bindings.
 * Authorization has already happened on the gateway; this only normalizes
 * response metadata and keeps the primary vault first.
 */
export function normalizePairingVaults(
  response: Record<string, unknown>
): CompanionVault[] {
  const metadata = new Map<string, CompanionVault>();
  const rawVaults = response["vaults"];
  if (Array.isArray(rawVaults)) {
    for (const raw of rawVaults) {
      if (!raw || typeof raw !== "object") continue;
      const value = raw as Record<string, unknown>;
      const vaultId = stringField(value["vaultId"]);
      if (!vaultId) continue;
      metadata.set(vaultId, {
        vaultId,
        ...(stringField(value["enrollmentId"])
          ? { enrollmentId: stringField(value["enrollmentId"]) }
          : {}),
        ...(stringField(value["vaultName"])
          ? { vaultName: stringField(value["vaultName"]) }
          : {}),
        ...(roleField(value["role"]) ? { role: roleField(value["role"]) } : {}),
      });
    }
  }
  const rawIds = response["vaultIds"];
  const ids = [
    // COMPAT(pair-ticket-multi-vault): added 2026-08-02, drop when floor >= pair-ticket-multi-vault-v1
    stringField(response["vaultId"]),
    ...(Array.isArray(rawIds) ? rawIds.map(stringField) : []),
    ...metadata.keys(),
  ].filter(
    (vaultId, index, all): vaultId is string =>
      vaultId !== undefined && all.indexOf(vaultId) === index
  );
  return ids.map((vaultId) => metadata.get(vaultId) ?? { vaultId });
}
