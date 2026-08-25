// Pure pairing-ticket redemption (#376). `decodePairingTicket` is a lockstep
// mirror of `encodePairingTicket` — not an import of `@centraid/server`.

export interface PairingTicketPayload {
  v: 1;
  kind: "centraid-gw-pair";
  gw: string;
  t: string;
  s: string;
  vaultName: string;
  exp: number;
}

/** `undefined` on anything malformed. */
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

/** Fast-feedback only — the gateway re-checks on redemption regardless. */
export function isTicketExpired(
  payload: Pick<PairingTicketPayload, "exp">,
  now = Date.now()
): boolean {
  return payload.exp <= now;
}

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

export function isFoldError(
  folded: FoldedPairing
): folded is { error: RedeemPairingErrorCode; message: string } {
  return "error" in folded;
}

export function findReusableProfile<P extends { endpointId?: string }>(
  profiles: readonly P[],
  endpointId: string
): P | undefined {
  return profiles.find((profile) => profile.endpointId === endpointId);
}
