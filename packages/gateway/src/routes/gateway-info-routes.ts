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
 * `instanceId` (issue #351) is the per-PROCESS uuid `GatewayInstanceLease`
 * mints at construction.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ROUTES, buildGatewayInfoPayload, type GatewayCapabilities } from '@centraid/protocol';
import type { RouteHandler } from '../serve/build-gateway.js';
import { sendJson } from './route-helpers.js';

const INFO_PATH = ROUTES.gatewayInfo;

export interface GatewayInfoRouteOptions {
  /** This process's `GatewayInstanceLease.instanceId` (issue #351). */
  instanceId: string;
  /** Optional capability overrides (tests / reduced surfaces). */
  capabilities?: GatewayCapabilities;
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
    return sendJson(
      res,
      200,
      buildGatewayInfoPayload({
        instanceId: options.instanceId,
        startedAt,
        uptimeMs: Date.now() - startedAt,
        ...(options.capabilities ? { capabilities: options.capabilities } : {}),
      }),
    );
  };
}
