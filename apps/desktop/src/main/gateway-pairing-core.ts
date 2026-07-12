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
  kind: 'centraid-gw-pair';
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
export function decodePairingTicket(raw: string): PairingTicketPayload | undefined {
  try {
    const obj = JSON.parse(
      Buffer.from(raw.trim(), 'base64url').toString('utf8'),
    ) as Partial<PairingTicketPayload>;
    if (obj.v !== 1 || obj.kind !== 'centraid-gw-pair') return undefined;
    if (typeof obj.gw !== 'string' || obj.gw.length === 0) return undefined;
    if (typeof obj.t !== 'string' || obj.t.length === 0) return undefined;
    if (typeof obj.s !== 'string' || obj.s.length === 0) return undefined;
    if (typeof obj.vaultName !== 'string') return undefined;
    if (typeof obj.exp !== 'number' || !Number.isFinite(obj.exp)) return undefined;
    return obj as PairingTicketPayload;
  } catch {
    return undefined;
  }
}

/**
 * Client-side fast-feedback expiry check. The gateway re-checks on
 * redemption regardless (the ticket store burns on any redemption attempt),
 * so this only exists to fail a stale paste instantly, before ever dialing.
 */
export function isTicketExpired(payload: Pick<PairingTicketPayload, 'exp'>, now = Date.now()): boolean {
  return payload.exp <= now;
}

/** Stable error codes `redeemGatewayPairing` can return — never a raw throw. */
export type RedeemPairingErrorCode =
  | 'invalid_ticket'
  | 'ticket_expired'
  | 'invalid_input'
  | 'unreachable'
  | 'bad_response';

export type RedeemGatewayPairingResult =
  | { ok: true; gatewayId: string; vaultId: string; vaultName: string }
  | { ok: false; error: RedeemPairingErrorCode; message: string };

type FoldedPairing =
  | { vaultId: string; vaultName: string; gatewayName?: string; deviceToken?: string; deviceKey?: string }
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
  gatewayName?: string;
  vaultId?: string;
  vaultName?: string;
}): FoldedPairing {
  if (!response.ok) {
    if (response.error === 'ticket_expired') {
      return { error: 'ticket_expired', message: 'This pairing code has expired.' };
    }
    return {
      error: 'invalid_ticket',
      message: response.error ?? 'That pairing code was rejected by the gateway.',
    };
  }
  if (!response.vaultId) {
    return { error: 'bad_response', message: 'Gateway did not return a vault id.' };
  }
  return {
    vaultId: response.vaultId,
    vaultName: response.vaultName ?? '',
    ...(response.gatewayName ? { gatewayName: response.gatewayName } : {}),
  };
}

/**
 * Fold a `POST /centraid/_gateway/pair` HTTP response (the direct/Tailscale
 * pairing path) into the same shape as {@link foldIrohPairResponse}. Success
 * is `{ok:true, deviceToken, deviceKey?, vaultId, vaultName}`; rejection is
 * `403 {ok:false, error:'ticket_invalid'|'ticket_expired'}`.
 */
export function foldHttpPairResponse(status: number, body: unknown): FoldedPairing {
  if (status === 403) {
    const errorField =
      body && typeof body === 'object' ? (body as Record<string, unknown>).error : undefined;
    if (errorField === 'ticket_expired') {
      return { error: 'ticket_expired', message: 'This pairing code has expired.' };
    }
    return { error: 'invalid_ticket', message: 'That pairing code is not valid.' };
  }
  if (status !== 200) {
    return { error: 'unreachable', message: `HTTP ${status}` };
  }
  if (!body || typeof body !== 'object') {
    return { error: 'bad_response', message: 'Gateway returned a malformed pairing response.' };
  }
  const b = body as Record<string, unknown>;
  if (b.ok !== true) {
    return { error: 'invalid_ticket', message: 'That pairing code is not valid.' };
  }
  if (typeof b.deviceToken !== 'string' || b.deviceToken.length === 0) {
    return { error: 'bad_response', message: 'Gateway did not return a device token.' };
  }
  if (typeof b.vaultId !== 'string' || b.vaultId.length === 0) {
    return { error: 'bad_response', message: 'Gateway did not return a vault id.' };
  }
  return {
    deviceToken: b.deviceToken,
    ...(typeof b.deviceKey === 'string' ? { deviceKey: b.deviceKey } : {}),
    vaultId: b.vaultId,
    vaultName: typeof b.vaultName === 'string' ? b.vaultName : '',
  };
}

/** True when `err` (as returned by the fold functions above) is the error arm. */
export function isFoldError(
  folded: FoldedPairing,
): folded is { error: RedeemPairingErrorCode; message: string } {
  return 'error' in folded;
}

/**
 * Pick the profile — among already-added gateways — that a redemption
 * should reuse rather than duplicate. Pure so the "don't duplicate on
 * re-redeem" behavior is testable without touching disk.
 */
export function findReusableProfile<
  P extends { transport?: 'local' | 'iroh' | 'direct'; endpointTicket?: string; url?: string },
>(profiles: readonly P[], key: { endpointTicket: string } | { url: string }): P | undefined {
  if ('endpointTicket' in key) {
    return profiles.find((p) => p.transport === 'iroh' && p.endpointTicket === key.endpointTicket);
  }
  return profiles.find((p) => p.transport === 'direct' && p.url === key.url);
}
