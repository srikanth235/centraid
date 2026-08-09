/*
 * Pure core for gateway pairing-ticket redemption (issue #376, desktop half).
 *
 * The wire format is minted by `centraid-gateway pair --vault <name>`
 * (packages/gateway/src/serve/pairing-store.ts's `encodePairingTicket`):
 * base64url JSON `{v:1, kind:'centraid-gw-pair', gw, t, s, vaultName, exp}`.
 * `decodePairingTicket` below is a LOCKSTEP mirror of that shape — the same
 * convention `apps/mobile/src/lib/phone-link.ts`'s `parsePairQr` uses for the
 * phone-pairing QR — rather than an import of gateway internals: desktop
 * main doesn't take `@centraid/gateway` as a dependency for a one-shot
 * decode, and the two copies are cheap to keep in sync (the payload is
 * frozen wire format, not an evolving API).
 *
 * Everything here is synchronous, side-effect-free, and electron-free, so it
 * unit-tests as plain data-in/data-out logic. `gateway-pairing.ts` wires the
 * real tunnel dial / HTTP fetch / gateway-store + settings calls around it,
 * the same "electron-free pure core" split as `gateway-ops-core.ts`.
 */

/** The pasteable one-line pairing token, decoded. */
export interface PairingTicketPayload {
  v: 1;
  kind: "centraid-gw-pair";
  /** The gateway's iroh EndpointTicket string — identity pin + relay hint. */
  gw: string;
  /** Ticket id (public half of the one-time ticket). */
  t: string;
  /** One-time secret (private half). */
  s: string;
  /** Owner-facing vault name, so the client can label the pair before dialing. */
  vaultName: string;
  /** Ticket expiry, epoch ms. */
  exp: number;
}

/** Decode + shape-validate a pasted pairing token. `undefined` on anything malformed. */
export function decodePairingTicket(
  raw: string
): PairingTicketPayload | undefined {
  try {
    const obj = JSON.parse(
      Buffer.from(raw.trim(), "base64url").toString("utf8")
    ) as Partial<PairingTicketPayload>;
    if (obj.v !== 1 || obj.kind !== "centraid-gw-pair") return undefined;
    if (typeof obj.gw !== "string" || obj.gw.length === 0) return undefined;
    if (typeof obj.t !== "string" || obj.t.length === 0) return undefined;
    if (typeof obj.s !== "string" || obj.s.length === 0) return undefined;
    if (typeof obj.vaultName !== "string") return undefined;
    if (typeof obj.exp !== "number" || !Number.isFinite(obj.exp))
      return undefined;
    return obj as PairingTicketPayload;
  } catch {
    return undefined;
  }
}

/**
 * Client-side fast-feedback expiry check. The gateway re-checks on
 * redemption regardless, so this only exists to fail a stale paste instantly,
 * before ever dialing.
 */
export function isTicketExpired(
  payload: Pick<PairingTicketPayload, "exp">,
  now = Date.now()
): boolean {
  return payload.exp <= now;
}

/** Stable error codes `redeemGatewayPairing` can return — never a raw throw. */
export type RedeemPairingErrorCode =
  | "invalid_ticket"
  | "ticket_expired"
  | "invalid_input"
  | "unreachable"
  | "bad_response";

export interface PairedVault {
  vaultId: string;
  enrollmentId?: string;
  vaultName?: string;
}

export type RedeemGatewayPairingResult =
  | {
      ok: true;
      gatewayId: string;
      vaultId: string;
      vaultName: string;
      vaultIds: string[];
      vaults: PairedVault[];
    }
  | { ok: false; error: RedeemPairingErrorCode; message: string };

type FoldedPairing =
  | {
      gatewayId: string;
      vaultId: string;
      vaultName: string;
      vaultIds: string[];
      vaults: PairedVault[];
      gatewayName?: string;
    }
  | { error: RedeemPairingErrorCode; message: string };

/**
 * Fold a `centraid/gw-pair/1` tunnel response (`GatewayPairResponse` from
 * `@centraid/tunnel`) into either the fields `gateway-pairing.ts` needs to
 * finish the iroh redemption, or a stable error. Pure — the tunnel dial and
 * the profile-side effects (addGateway / setActiveGatewayId / setActiveVaultId)
 * happen around this, not in it.
 */
export function foldIrohPairResponse(response: {
  ok: boolean;
  error?: string;
  gatewayId?: string;
  gatewayName?: string;
  vaultId?: string;
  vaultName?: string;
  vaultIds?: string[];
  vaults?: PairedVault[];
}): FoldedPairing {
  if (!response.ok) {
    if (response.error === "ticket_expired") {
      return {
        error: "ticket_expired",
        message: "This pairing code has expired.",
      };
    }
    return {
      error: "invalid_ticket",
      message:
        response.error ?? "That pairing code was rejected by the gateway.",
    };
  }
  if (!response.vaultId) {
    return {
      error: "bad_response",
      message: "Gateway did not return a vault id.",
    };
  }
  if (!response.gatewayId) {
    return {
      error: "bad_response",
      message: "Gateway did not return its EndpointId.",
    };
  }
  const vaults = (response.vaults ?? []).filter(
    (vault) => typeof vault.vaultId === "string" && vault.vaultId.length > 0
  );
  // COMPAT(pair-ticket-multi-vault): added 2026-08-02, drop when floor >= pair-ticket-multi-vault-v1
  const vaultIds = [
    response.vaultId,
    ...(response.vaultIds ?? []),
    ...vaults.map((vault) => vault.vaultId),
  ].filter(
    (vaultId, index, all): vaultId is string =>
      typeof vaultId === "string" &&
      vaultId.length > 0 &&
      all.indexOf(vaultId) === index
  );
  return {
    gatewayId: response.gatewayId,
    vaultId: response.vaultId,
    vaultName: response.vaultName ?? "",
    vaultIds,
    vaults,
    ...(response.gatewayName ? { gatewayName: response.gatewayName } : {}),
  };
}

/** True when `err` (as returned by the fold functions above) is the error arm. */
export function isFoldError(
  folded: FoldedPairing
): folded is { error: RedeemPairingErrorCode; message: string } {
  return "error" in folded;
}

/**
 * Pick the profile — among already-added gateways — that a redemption
 * should reuse rather than duplicate. Pure so the "don't duplicate on
 * re-redeem" behavior is testable without touching disk.
 */
export function findReusableProfile<P extends { endpointId?: string }>(
  profiles: readonly P[],
  endpointId: string
): P | undefined {
  return profiles.find((profile) => profile.endpointId === endpointId);
}
