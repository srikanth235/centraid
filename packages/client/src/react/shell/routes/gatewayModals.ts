import type { CentraidRedeemGatewayPairingResult } from '../../../centraid-api.js';

// Gateway I/O for the "Add gateway" flow (issue #376), mirroring spaceModals.ts's
// split: chrome (GatewayModal / GatewayPairingForm) is React, the gateway I/O
// lives here so it's plain-async-function testable. Three credential shapes,
// one result type — GatewayPairingForm builds the input from whatever the user
// filled in and doesn't need to know the wire details.
//
//   - `ticket`      — the default flow: paste a pairing ticket minted by
//     `centraid-gateway pair --vault <name>`, redeemed over the iroh tunnel.
//   - `ticket-url`  — same ticket, but redeemed over an explicit URL (`mode:
//     'http'`) for landlord/admin/Tailscale setups that skip iroh discovery.
//   - `token`       — no ticket at all: a bearer token minted out-of-band,
//     added via the existing `addGateway` direct path. Unlike the ticket
//     flows this does NOT enroll a vault (there's no ticket payload telling
//     us which one) — success only adds + switches to the gateway, landing
//     on whatever vault is already active there.

export interface GatewayConnectSuccess {
  ok: true;
  /** Vault name (ticket flows) or the gateway's own label (token flow) —
   *  whichever the connect actually resolved, for "Connected to X" copy. */
  label: string;
  gatewayId: string;
  vaultId?: string;
}
export interface GatewayConnectFailure {
  ok: false;
  /** Already run through `friendlyGatewayError` — safe to show as-is. */
  message: string;
}
export type GatewayConnectResult = GatewayConnectSuccess | GatewayConnectFailure;

export type GatewayPairingInput =
  | { kind: 'ticket'; ticket: string; label?: string }
  | { kind: 'ticket-url'; ticket: string; url: string; label?: string }
  | { kind: 'token'; url: string; token: string; label: string };

// Copy for `redeemGatewayPairing`'s stable error codes (centraid-api.d.ts).
// Anything not in this map (or the raw `addGateway` throw path) falls back to
// the server-supplied message, which is itself written to be shown as-is.
const FRIENDLY_ERRORS: Record<string, string> = {
  invalid_ticket: "That pairing code isn't valid — double-check you copied the whole thing.",
  ticket_expired: 'This ticket has expired — ask for a new one.',
  invalid_input: 'That URL or ticket looks malformed — double-check it and try again.',
  unreachable: "Couldn't reach that gateway — check the URL and that it's running.",
  bad_response: 'The gateway sent back something unexpected. Try again in a moment.',
};

/** Map a stable error code to friendly copy; falls back to the raw message. */
export function friendlyGatewayError(error: string, message: string): string {
  return FRIENDLY_ERRORS[error] ?? message;
}

function foldRedeemResult(res: CentraidRedeemGatewayPairingResult): GatewayConnectResult {
  if (res.ok) {
    return {
      gatewayId: res.gatewayId,
      label: res.vaultName || 'your vault',
      ok: true,
      vaultId: res.vaultId,
    };
  }
  return { message: friendlyGatewayError(res.error, res.message), ok: false };
}

/**
 * Redeem a pairing ticket (default iroh dial, or `mode:'http'` when the
 * caller supplied a URL) or add a token-authenticated gateway directly.
 * The ticket flows switch the active gateway + vault as a side effect
 * (main's `redeemGatewayPairing`); the token flow switches active gateway
 * only, via an explicit `setActiveGateway` follow-up. Never throws — the
 * `redeemGatewayPairing` IPC already resolves failures as `{ok:false}`, and
 * the `addGateway` throw path is caught here to match.
 */
export async function connectGateway(input: GatewayPairingInput): Promise<GatewayConnectResult> {
  if (input.kind === 'token') {
    try {
      const profile = await window.CentraidApi.addGateway({
        label: input.label,
        token: input.token,
        url: input.url,
      });
      await window.CentraidApi.setActiveGateway({ id: profile.id });
      return { gatewayId: profile.id, label: profile.displayName ?? profile.label, ok: true };
    } catch (err) {
      return { message: err instanceof Error ? err.message : String(err), ok: false };
    }
  }
  const res = await window.CentraidApi.redeemGatewayPairing(
    input.kind === 'ticket-url'
      ? { label: input.label, mode: 'http', ticket: input.ticket, url: input.url }
      : { label: input.label, ticket: input.ticket },
  );
  return foldRedeemResult(res);
}
