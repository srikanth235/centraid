/*
 * `GET /centraid/_gateway/info` — gateway identity + version handshake
 * (issue #289 / #504).
 *
 * The one route a client reads BEFORE trusting anything else about a
 * gateway: software version + schema epoch (exact-match or refuse in v0),
 * capability map (C1), and for device-scoped transports, which vaults the
 * calling device may address. Health polling hits it every few seconds, so
 * it also carries the server-reported runtime clock (`startedAt` /
 * `uptimeMs`).
 *
 * `instanceId` is a per-process UUID, independent of the stable EndpointId.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ROUTES, buildGatewayInfoPayload, type GatewayCapabilities } from '@centraid/protocol';
import type { RouteHandler } from '../serve/build-gateway.js';
import { isLoopbackRequest, sendJson } from './route-helpers.js';

const INFO_PATH = ROUTES.gatewayInfo;

export interface GatewayInfoRouteOptions {
  /** Ephemeral identity for this running process. */
  instanceId: string;
  /** Optional capability overrides (tests / reduced surfaces). */
  capabilities?: GatewayCapabilities;
  /** Read live because the first vault may be founded after process boot. */
  status?: () => 'uninitialized' | 'ready';
  /** Stable identity can be derived before the endpoint joins the network. */
  endpointId?: () => string | undefined;
  /** Current relay/address data. Never publish this beyond the local host. */
  endpointTicket?: () => string | undefined;
}

export function makeGatewayInfoRouteHandler(options: GatewayInfoRouteOptions): RouteHandler {
  // The factory runs once inside buildGateway, so this IS process start
  // for the serving gateway.
  const startedAt = Date.now();
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (url.pathname !== INFO_PATH) return false;
    if ((req.method ?? 'GET') !== 'GET') {
      return sendJson(res, 405, { error: 'method_not_allowed', message: 'GET only' });
    }
    const endpointId = options.endpointId?.();
    const endpointTicket = isLoopbackRequest(req) ? options.endpointTicket?.() : undefined;
    return sendJson(
      res,
      200,
      buildGatewayInfoPayload({
        instanceId: options.instanceId,
        startedAt,
        uptimeMs: Date.now() - startedAt,
        status: options.status?.() ?? 'ready',
        ...(endpointId !== undefined ? { endpointId } : {}),
        ...(endpointTicket !== undefined ? { endpointTicket } : {}),
        ...(options.capabilities ? { capabilities: options.capabilities } : {}),
      }),
    );
  };
}
