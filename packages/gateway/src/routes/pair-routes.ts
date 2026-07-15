/*
 * `POST /centraid/_gateway/pair` — public HTTP ticket redemption (issue
 * #376) for devices that speak the gateway's HTTP surface directly and
 * cannot dial the iroh endpoint (a browser, a first-class HTTP client, a
 * platform with no iroh binding). It is the HTTP twin of the iroh
 * `centraid/gw-pair/1` ALPN `endpoint-host.ts` handles — same
 * `PairingTicketStore` burn-once ceremony, same one bit of ACL — but it
 * mints a device HTTP token (`device-token-store.ts`) instead of
 * admitting a QUIC peer.
 *
 * Mounted WITHOUT the bearer check — `serve.ts` adds `PAIR_ROUTE_PATH` to
 * `startRuntimeHttpServer`'s `publicPaths` whenever `devicePairing` is
 * configured: the one-time ticket secret IS the auth. A caller with no
 * valid ticket learns nothing beyond `ticket_invalid` — the SAME failure
 * for a wrong secret, an unknown id, or an expired ticket, mirroring
 * `PairingTicketStore.redeem`'s single-outcome-for-every-failure design
 * (it would defeat the point to let a client distinguish "expired" from
 * "guessed wrong").
 */

import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler } from '../serve/build-gateway.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import type { EnrollmentStore } from '../serve/enrollment-store.js';
import { type PairingTicketStore, parsePairingTicket } from '../serve/pairing-store.js';
import type { DeviceTokenStore } from '../serve/device-token-store.js';
import { readJson, sendJson } from './route-helpers.js';

export const PAIR_ROUTE_PATH = '/centraid/_gateway/pair';

export interface PairRouteDeps {
  vaults: VaultRegistry;
  tickets: PairingTicketStore;
  enrollments: EnrollmentStore;
  deviceTokens: DeviceTokenStore;
}

/** The exact request body this route accepts — the desktop agent's HTTP-pair client relies on this shape. */
interface PairRequestBody {
  /** The pasteable base64url ticket string minted by `centraid-gateway pair`. */
  ticket: string;
  /** Owner-facing device label. */
  deviceLabel: string;
  platform?: string;
  /** Persist the replica/intent queue on this device. Omission is an explicit opt-out. */
  rememberDevice?: boolean;
  /** A companion may voluntarily enroll read-only; full remains the legacy default. */
  trust?: 'full' | 'readonly';
}

function parseBody(body: Record<string, unknown>): PairRequestBody | undefined {
  const { ticket, deviceLabel, platform, rememberDevice, trust } = body;
  if (typeof ticket !== 'string' || ticket.length === 0) return undefined;
  if (typeof deviceLabel !== 'string' || deviceLabel.trim().length === 0) return undefined;
  if (platform !== undefined && typeof platform !== 'string') return undefined;
  if (rememberDevice !== undefined && typeof rememberDevice !== 'boolean') return undefined;
  if (trust !== undefined && trust !== 'full' && trust !== 'readonly') return undefined;
  return {
    ticket,
    deviceLabel,
    ...(platform !== undefined ? { platform } : {}),
    ...(rememberDevice !== undefined ? { rememberDevice } : {}),
    ...(trust !== undefined ? { trust } : {}),
  };
}

export function makePairRouteHandler(deps: PairRouteDeps): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';
    if (pathname !== PAIR_ROUTE_PATH) return false;
    if ((req.method ?? 'GET') !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      return true;
    }

    let raw: Record<string, unknown>;
    try {
      raw = await readJson(req);
    } catch {
      sendJson(res, 400, { ok: false, error: 'malformed_request' });
      return true;
    }
    const body = parseBody(raw);
    if (!body) {
      sendJson(res, 400, { ok: false, error: 'malformed_request' });
      return true;
    }

    const payload = parsePairingTicket(body.ticket);
    if (!payload) {
      sendJson(res, 403, { ok: false, error: 'ticket_invalid' });
      return true;
    }

    const redeemed = deps.tickets.redeem(payload.t, payload.s);
    if (!redeemed) {
      // Wrong secret, unknown ticket id, and expired-but-well-formed all
      // land here on purpose — see the module header.
      sendJson(res, 403, { ok: false, error: 'ticket_invalid' });
      return true;
    }

    const plane = deps.vaults.get(redeemed.vaultId);
    if (!plane) {
      sendJson(res, 403, { ok: false, error: 'ticket_invalid' });
      return true;
    }

    // No iroh identity of its own — mint a synthetic key in the same
    // namespace `EnrollmentStore` rows already key off.
    const deviceKey = `http:${crypto.randomUUID()}`;
    const enrollment = deps.enrollments.enroll({
      endpointId: deviceKey,
      vaultId: redeemed.vaultId,
      label: body.deviceLabel,
      ...(body.platform !== undefined ? { platform: body.platform } : {}),
      ...(body.rememberDevice !== undefined ? { rememberDevice: body.rememberDevice } : {}),
      ...(body.trust !== undefined ? { trust: body.trust } : {}),
    });
    const minted = deps.deviceTokens.mint({ deviceKey, label: body.deviceLabel });

    sendJson(res, 200, {
      ok: true,
      deviceToken: minted.token,
      deviceKey,
      vaultId: redeemed.vaultId,
      vaultName: plane.name,
      trust: enrollment.trust,
      rememberDevice: enrollment.rememberDevice,
    });
    return true;
  };
}
