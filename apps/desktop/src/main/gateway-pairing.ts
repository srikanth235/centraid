/*
 * Iroh-only gateway pairing (#555).
 *
 * The one-time ticket supplies the gateway's stable EndpointId plus a current
 * relay hint. Redemption may enroll this device into several vaults at once;
 * the first returned vault is the initial focus. We persist the EndpointId as
 * connection identity, refresh the hint, and keep this device's iroh key in
 * safeStorage under that EndpointId.
 */

import os from "node:os";

import {
  createTunnelClient,
  inspectEndpointTicket,
  sanitizeDeviceName,
} from "@centraid/tunnel";

import {
  decodePairingTicket,
  findReusableProfile,
  foldIrohPairResponse,
  isFoldError,
  isTicketExpired,
} from "./gateway-pairing-core.js";
import type { RedeemGatewayPairingResult } from "./gateway-pairing-core.js";
import {
  addGateway,
  listGateways,
  updateGatewayRelayHint,
  updateGatewayRememberDevice,
} from "./gateway-store.js";
import type { GatewayProfile } from "./gateway-store.js";
import { ensureIrohDeviceKey } from "./iroh-dialer.js";
import { setActiveGatewayId, setActiveVaultId } from "./settings.js";

export type { RedeemGatewayPairingResult } from "./gateway-pairing-core.js";

export interface RedeemGatewayPairingInput {
  ticket: string;
  label?: string;
  rememberDevice?: boolean;
}

function localDeviceName(label: string | undefined): string {
  return sanitizeDeviceName(
    label?.trim() || os.hostname().replace(/\.local$/u, "")
  );
}

export async function redeemGatewayPairing(
  input: RedeemGatewayPairingInput
): Promise<RedeemGatewayPairingResult> {
  const payload = decodePairingTicket(input.ticket);
  if (!payload) {
    return {
      ok: false,
      error: "invalid_ticket",
      message: "That pairing code is not valid.",
    };
  }
  if (isTicketExpired(payload)) {
    return {
      ok: false,
      error: "ticket_expired",
      message: "This pairing code has expired.",
    };
  }

  let hint: ReturnType<typeof inspectEndpointTicket>;
  try {
    hint = inspectEndpointTicket(payload.gw);
  } catch {
    return {
      ok: false,
      error: "invalid_ticket",
      message: "That pairing code is not valid.",
    };
  }

  const rememberDevice = input.rememberDevice ?? false;
  const client = await createTunnelClient({
    secretKey: ensureIrohDeviceKey(hint.endpointId),
  });
  let response: Awaited<ReturnType<typeof client.pairGateway>>;
  try {
    response = await client.pairGateway(payload.gw, {
      ticketId: payload.t,
      secret: payload.s,
      deviceName: localDeviceName(input.label),
      platform: process.platform,
      rememberDevice,
    });
  } catch (error) {
    await client.close().catch(() => undefined);
    return {
      ok: false,
      error: "unreachable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  await client.close().catch(() => undefined);

  const folded = foldIrohPairResponse(response);
  if (isFoldError(folded))
    return { ok: false, error: folded.error, message: folded.message };
  if (folded.gatewayId !== hint.endpointId) {
    return {
      ok: false,
      error: "bad_response",
      message: "The gateway identity did not match the pairing ticket.",
    };
  }

  const profiles = await listGateways();
  const existing = findReusableProfile(profiles, hint.endpointId);
  const profile: GatewayProfile =
    existing ??
    (await addGateway({
      label:
        input.label?.trim() ||
        folded.gatewayName?.trim() ||
        folded.vaultName ||
        payload.vaultName,
      endpointId: hint.endpointId,
      ...(hint.relayHint ? { relayHint: hint.relayHint } : {}),
      rememberDevice,
    }));
  if (existing) {
    await updateGatewayRememberDevice(existing.id, rememberDevice);
    await updateGatewayRelayHint(existing.id, hint.relayHint);
  }

  await setActiveGatewayId(profile.id);
  await setActiveVaultId(folded.vaultId);
  return {
    ok: true,
    gatewayId: profile.id,
    vaultId: folded.vaultId,
    vaultName: folded.vaultName || payload.vaultName,
    vaultIds: folded.vaultIds,
    vaults: folded.vaults,
  };
}
