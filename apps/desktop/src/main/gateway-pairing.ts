/*
 * Gateway pairing-ticket redemption (issue #376, desktop half).
 *
 * The owner mints a one-time ticket on the gateway (`centraid-gateway pair
 * --vault <name>`) and pastes/scans it here. Two redemption transports:
 *
 *   - `iroh` (default): dial `centraid/gw-pair/1` with the desktop's
 *     PERSISTENT iroh identity for this (would-be) gateway profile — see
 *     `iroh-dialer.ts`'s `ensureIrohDeviceKey` doc comment for why the
 *     pairing dial and the later data-plane dial must share one key. On
 *     success we add (or reuse) an `iroh` gateway profile.
 *   - `http` (when the caller passes a `url` — direct/Tailscale setups):
 *     `POST <url>/centraid/_gateway/pair`. On success we add (or reuse) a
 *     `direct` gateway profile and store the returned device token.
 *
 * Either way, success flips the active gateway AND the active vault on it
 * (the ticket enrolls into exactly one vault) — the IPC handler in `ipc.ts`
 * runs the same cache-invalidation + broadcast steps `GATEWAYS_SET_ACTIVE`
 * / `VAULTS_SET_ACTIVE` already run, so this module stays free of
 * `BrowserWindow` and is plain-async-function testable.
 *
 * Never throws across the call — every failure resolves to `{ok:false,
 * error, message}` with a stable `error` code.
 */

import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createTunnelClient, sanitizeDeviceName } from '@centraid/tunnel';
import {
  addGateway,
  listGateways,
  updateGatewayToken,
  type GatewayProfile,
} from './gateway-store.js';
import { ensureIrohDeviceKey } from './iroh-dialer.js';
import { setActiveGatewayId, setActiveVaultId } from './settings.js';
import {
  decodePairingTicket,
  findReusableProfile,
  foldHttpPairResponse,
  foldIrohPairResponse,
  isFoldError,
  isTicketExpired,
  type RedeemGatewayPairingResult,
} from './gateway-pairing-core.js';

export type { RedeemGatewayPairingResult } from './gateway-pairing-core.js';

export interface RedeemGatewayPairingInput {
  /** The pasted/scanned one-line pairing token. */
  ticket: string;
  /** Optional profile label; falls back to the gateway/vault's own name. */
  label?: string;
  /** `auto` (default) picks `http` when `url` is set, else `iroh`. */
  mode?: 'auto' | 'iroh' | 'http';
  /** Required (and only meaningful) for the `http` transport. */
  url?: string;
}

/** This device's name as presented to a gateway during pairing (also the fallback profile label). */
function localDeviceName(label: string | undefined): string {
  const raw = label?.trim() || os.hostname().replace(/\.local$/, '');
  return sanitizeDeviceName(raw);
}

export async function redeemGatewayPairing(
  input: RedeemGatewayPairingInput,
): Promise<RedeemGatewayPairingResult> {
  const payload = decodePairingTicket(input.ticket);
  if (!payload) {
    return { ok: false, error: 'invalid_ticket', message: 'That pairing code is not valid.' };
  }
  if (isTicketExpired(payload)) {
    return { ok: false, error: 'ticket_expired', message: 'This pairing code has expired.' };
  }

  const requestedMode = input.mode ?? 'auto';
  const effectiveMode = requestedMode === 'auto' ? (input.url ? 'http' : 'iroh') : requestedMode;

  if (effectiveMode === 'http') {
    if (!input.url) {
      return {
        ok: false,
        error: 'invalid_input',
        message: 'A gateway URL is required for http pairing.',
      };
    }
    return redeemHttp(input.url, input.ticket, input.label);
  }
  return redeemIroh(payload, input.label);
}

async function redeemIroh(
  payload: NonNullable<ReturnType<typeof decodePairingTicket>>,
  label: string | undefined,
): Promise<RedeemGatewayPairingResult> {
  const profiles = await listGateways();
  const existing = findReusableProfile(profiles, { endpointTicket: payload.gw });
  const gatewayId = existing?.id ?? randomUUID();

  const client = await createTunnelClient({ secretKey: ensureIrohDeviceKey(gatewayId) });
  let response: Awaited<ReturnType<typeof client.pairGateway>>;
  try {
    response = await client.pairGateway(payload.gw, {
      ticketId: payload.t,
      secret: payload.s,
      deviceName: localDeviceName(label),
      platform: process.platform,
    });
  } catch (err) {
    await client.close().catch(() => undefined);
    return {
      ok: false,
      error: 'unreachable',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  const endpointId = client.endpointId;
  await client.close().catch(() => undefined);

  const folded = foldIrohPairResponse(response);
  if (isFoldError(folded)) return { ok: false, error: folded.error, message: folded.message };

  // No bearer for the iroh transport (issue #376 decision): the gateway's
  // tunnel endpoint stamps its OWN upstream token onto every forwarded
  // request (`packages/tunnel/src/gateway-endpoint.ts`'s
  // `headers.authorization = Bearer ${upstream.token}`) — the caller's
  // identity is proven by the QUIC handshake, not a header it presents. So
  // `resolveGateway`'s `getGatewayToken(id) ?? ''` staying empty for an
  // `iroh` profile is correct, not a gap; nothing to store here.
  const profile: GatewayProfile =
    existing ??
    (await addGateway({
      id: gatewayId,
      label: label?.trim() || folded.gatewayName?.trim() || folded.vaultName || payload.vaultName,
      endpointTicket: payload.gw,
      endpointId,
      token: '',
    }));

  await setActiveGatewayId(profile.id);
  await setActiveVaultId(folded.vaultId);

  return {
    ok: true,
    gatewayId: profile.id,
    vaultId: folded.vaultId,
    vaultName: folded.vaultName || payload.vaultName,
  };
}

async function redeemHttp(
  url: string,
  rawTicket: string,
  label: string | undefined,
): Promise<RedeemGatewayPairingResult> {
  const base = url.replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(new URL('/centraid/_gateway/pair', `${base}/`).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ticket: rawTicket,
        deviceLabel: localDeviceName(label),
        platform: process.platform,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      error: 'unreachable',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const folded = foldHttpPairResponse(res.status, body);
  if (isFoldError(folded)) return { ok: false, error: folded.error, message: folded.message };
  // foldHttpPairResponse guarantees deviceToken is a non-empty string on the
  // success arm — narrow it here so the rest of this function doesn't have
  // to keep re-checking.
  const deviceToken = folded.deviceToken as string;

  const profiles = await listGateways();
  const existing = findReusableProfile(profiles, { url: base });
  const profile: GatewayProfile =
    existing ??
    (await addGateway({
      label: label?.trim() || folded.vaultName || 'Gateway',
      url: base,
      token: deviceToken,
    }));
  if (existing) await updateGatewayToken(existing.id, deviceToken);

  await setActiveGatewayId(profile.id);
  await setActiveVaultId(folded.vaultId);

  return { ok: true, gatewayId: profile.id, vaultId: folded.vaultId, vaultName: folded.vaultName };
}
