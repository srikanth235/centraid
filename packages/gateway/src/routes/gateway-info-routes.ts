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
import { AUTHED_PLANE_HEADER } from '@centraid/app-engine';
import { ROUTES, buildGatewayInfoPayload, type GatewayCapabilities } from '@centraid/protocol';
import type { RouteHandler } from '../serve/build-gateway.js';
import { sendJson } from './route-helpers.js';

const INFO_PATH = ROUTES.gatewayInfo;

export interface GatewayInfoRouteOptions {
  /** Ephemeral identity for this running process. */
  instanceId: string;
  /** Optional capability overrides (tests / reduced surfaces). */
  capabilities?: GatewayCapabilities;
  /** Stable identity can be derived before the endpoint joins the network. */
  endpointId?: () => string | undefined;
  /**
   * Current relay/address data — a dial ticket for this gateway's iroh
   * endpoint. Served ONLY to a caller that presented a valid credential
   * (issue #568 item C).
   *
   * The route itself is public because a client must read the version /
   * schema handshake before it can pair, and `isLoopbackRequest` is not a
   * substitute for authentication: a browser fetch to `http://127.0.0.1:<port>`
   * from any page the owner happens to visit is a loopback socket, needs no
   * preflight for a plain GET, and `decideCors` answers it `*`.
   */
  endpointTicket?: () => string | undefined;
}

/**
 * Did the HTTP layer resolve a credential for this request? `publicPaths`
 * skips the 401, not the evaluation — `AUTHED_PLANE_HEADER` is stamped by
 * `startRuntimeHttpServer` and stripped from every inbound request first,
 * so a client cannot forge it.
 */
function isAuthenticated(req: IncomingMessage): boolean {
  return typeof req.headers[AUTHED_PLANE_HEADER] === 'string';
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
    // Reported on the payload (issue #603): an anonymous caller silently loses
    // `endpointTicket`, and without this flag a bearer mismatch is
    // indistinguishable from an endpoint that has not come up yet.
    const authenticated = isAuthenticated(req);
    const endpointTicket = authenticated ? options.endpointTicket?.() : undefined;
    return sendJson(
      res,
      200,
      buildGatewayInfoPayload({
        instanceId: options.instanceId,
        startedAt,
        uptimeMs: Date.now() - startedAt,
        authenticated,
        ...(endpointId !== undefined ? { endpointId } : {}),
        ...(endpointTicket !== undefined ? { endpointTicket } : {}),
        ...(options.capabilities ? { capabilities: options.capabilities } : {}),
      }),
    );
  };
}
