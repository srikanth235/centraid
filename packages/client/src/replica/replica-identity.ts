// WHICH VAULT, ON WHICH GATEWAY (#289, #599).
//
// A replica's storage is keyed by `(gatewayId, vaultId)` and nothing else: two
// vaults on one gateway are two files, and the same vault on two gateways is
// two files as well. Everything here exists to make that key from what a caller
// actually holds, and to keep one spelling of it.
//
// A MODULE OF ITS OWN so the session and the scope registry can both have it
// without one importing the other — they are the two halves that were one file
// until W5, and this is the vocabulary they share.

import { doFetch, VAULT_HEADER } from "../gateway-client-core.js";
import type { GatewayAuth } from "../gateway-client-core.js";
import { ReplicaProtocolError } from "./errors.js";
import type { ReplicaFetcher } from "./shell-transport.js";
import type { ReplicaIdentity } from "./types.js";

export function replicaIdentityForGatewayAuth(
  gatewayAuth: GatewayAuth
): ReplicaIdentity {
  if (!gatewayAuth.vaultId)
    throw new ReplicaProtocolError("An addressed vault is required");
  return {
    gatewayId:
      gatewayAuth.gatewayId?.trim() ||
      normalizedGatewayUrl(gatewayAuth.baseUrl),
    vaultId: gatewayAuth.vaultId,
  };
}

/**
 * A gateway's URL, reduced to what identifies it.
 *
 * The hash, the query and a trailing slash are all things a caller can vary
 * without meaning a different gateway, and a key that varied with them would
 * open a second seat file for the same vault.
 */
export function normalizedGatewayUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return `url:${url.toString()}`;
  } catch {
    return `url:${value.replace(/\/+$/u, "")}`;
  }
}

export function sameIdentity(
  left: ReplicaIdentity,
  right: ReplicaIdentity
): boolean {
  return left.gatewayId === right.gatewayId && left.vaultId === right.vaultId;
}

/**
 * Stamp this session's vault on every request it makes.
 *
 * Ambient `withVaultHeader` follows the FOCUSED vault, so a background scope's
 * fetch would carry the foreground's id — and its answer would be written into
 * this scope's seat (#599).
 */
export function fetchReplicaForScope(gatewayAuth: GatewayAuth): ReplicaFetcher {
  return (baseUrl, pathname, init) => {
    if (!gatewayAuth.vaultId) return doFetch(baseUrl, pathname, init);
    const headers = new Headers(init.headers as HeadersInit | undefined);
    headers.set(VAULT_HEADER, gatewayAuth.vaultId);
    return doFetch(baseUrl, pathname, { ...init, headers });
  };
}
