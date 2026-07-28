import type { CentraidRedeemGatewayPairingResult } from "../../../centraid-api.js";

// Gateway I/O for the "Add gateway" flow (issue #376), mirroring spaceModals.ts's
// split: chrome (GatewayModal / GatewayPairingForm) is React, the gateway I/O
// lives here so it's plain-async-function testable. Three credential shapes,
// one result type — GatewayPairingForm builds the input from whatever the user
// filled in and doesn't need to know the wire details. A one-time ticket is
// the only connection shape; it is redeemed over iroh.

export interface GatewayConnectSuccess {
  ok: true;
  /** Vault name the pairing resolved, for "Connected to X" copy. */
  label: string;
  gatewayId: string;
  vaultId?: string;
}
export interface GatewayConnectFailure {
  ok: false;
  /** Already run through `friendlyGatewayError` — safe to show as-is. */
  message: string;
}
export type GatewayConnectResult =
  | GatewayConnectSuccess
  | GatewayConnectFailure;

export type GatewayPairingInput = {
  kind: "ticket";
  ticket: string;
  label?: string;
  rememberDevice?: boolean;
};

// Copy for `redeemGatewayPairing`'s stable error codes (centraid-api.d.ts).
// Anything not in this map (or the raw `addGateway` throw path) falls back to
// the server-supplied message, which is itself written to be shown as-is.
const FRIENDLY_ERRORS: Record<string, string> = {
  invalid_ticket:
    "That pairing code isn't valid — double-check you copied the whole thing.",
  ticket_expired: "This ticket has expired — ask for a new one.",
  invalid_input: "That ticket looks malformed — double-check it and try again.",
  unreachable: "Couldn't reach that gateway — check that it's running.",
  bad_response:
    "The gateway sent back something unexpected. Try again in a moment.",
};

/** Map a stable error code to friendly copy; falls back to the raw message. */
export function friendlyGatewayError(error: string, message: string): string {
  return FRIENDLY_ERRORS[error] ?? message;
}

function foldRedeemResult(
  res: CentraidRedeemGatewayPairingResult
): GatewayConnectResult {
  if (res.ok) {
    return {
      gatewayId: res.gatewayId,
      label: res.vaultName || "your vault",
      ok: true,
      vaultId: res.vaultId,
    };
  }
  return { message: friendlyGatewayError(res.error, res.message), ok: false };
}

/**
 * Redeem a pairing ticket — the only way to add a gateway (issue #505 phase 7,
 * which retired manual URL adds). The ceremony enrolls this device's iroh
 * identity and switches the active gateway + vault as a side effect. Never
 * throws — the `redeemGatewayPairing` IPC already resolves failures as
 * `{ok:false}`.
 */
export async function connectGateway(
  input: GatewayPairingInput
): Promise<GatewayConnectResult> {
  const res = await window.CentraidApi.redeemGatewayPairing({
    label: input.label,
    rememberDevice: input.rememberDevice ?? false,
    ticket: input.ticket,
  });
  return foldRedeemResult(res);
}
