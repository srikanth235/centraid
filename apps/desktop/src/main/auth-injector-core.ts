export interface AuthInjectorSnapshot {
  gatewayOrigin: string;
  gatewayToken: string;
  gatewayVaultId: string;
}

/** The vault-addressing header (mirrors the gateway's constant, #289). */
export const VAULT_HEADER = "x-centraid-vault";

export function matchesGateway(url: string, gatewayOrigin: string): boolean {
  try {
    return new URL(url).origin === gatewayOrigin;
  } catch {
    return false;
  }
}

export function applyOutgoingAuthHeaders(
  requestHeaders: Record<string, string>,
  snapshot: AuthInjectorSnapshot,
  url: string
): Record<string, string> {
  if (!snapshot.gatewayOrigin || !snapshot.gatewayToken) return requestHeaders;
  if (!matchesGateway(url, snapshot.gatewayOrigin)) return requestHeaders;
  const headers = { ...requestHeaders };
  const hasAuth = Object.keys(headers).some(
    (k) => k.toLowerCase() === "authorization"
  );
  if (!hasAuth) {
    headers.Authorization = `Bearer ${snapshot.gatewayToken}`;
  }
  if (snapshot.gatewayVaultId) {
    const hasVault = Object.keys(headers).some(
      (k) => k.toLowerCase() === VAULT_HEADER
    );
    if (!hasVault) headers[VAULT_HEADER] = snapshot.gatewayVaultId;
  }
  return headers;
}
