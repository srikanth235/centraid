import type { CentraidRedeemGatewayPairingResult } from "../../../centraid-api.js";

export interface GatewayConnectSuccess {
  ok: true;
  label: string;
  gatewayId: string;
  vaultId?: string;
  vaultIds: string[];
}
export interface GatewayConnectFailure {
  ok: false;
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

const FRIENDLY_ERRORS: Record<string, string> = {
  invalid_ticket:
    "That pairing code isn't valid — double-check you copied the whole thing.",
  ticket_expired: "This ticket has expired — ask for a new one.",
  invalid_input: "That ticket looks malformed — double-check it and try again.",
  unreachable: "Couldn't reach that host — check that it's running.",
  bad_response: "The host sent back something unexpected — try again.",
};

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
      vaultIds: res.vaultIds ?? (res.vaultId ? [res.vaultId] : []),
    };
  }
  return { message: friendlyGatewayError(res.error, res.message), ok: false };
}

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
