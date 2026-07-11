/*
 * `GET /centraid/_gateway/info` — gateway identity + version handshake
 * (issue #289).
 *
 * The one route a client reads BEFORE trusting anything else about a
 * gateway: software version + schema epoch (exact-match or refuse in v0)
 * and, for device-scoped transports, which vaults the calling device may
 * address (the composed handler already resolved that; this route is behind
 * it). Health polling hits it every few seconds, so it also carries the
 * server-reported runtime clock (`startedAt` / `uptimeMs`) — the desktop's
 * gateway-runtime page trusts the gateway's own account of how long it has
 * been up rather than inferring it from probe history.
 *
 * `instanceId` (issue #351) is the per-PROCESS uuid `GatewayInstanceLease`
 * mints at construction — additive, existing consumers (`version-handshake.ts`
 * only reads `version`/`schemaEpoch`) are unaffected. It lets a client notice
 * a gateway swap-under-it (restart, or a second instance winning a lease
 * fight) even when version/schemaEpoch stay identical across the swap.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler } from '../serve/build-gateway.js';
import { GATEWAY_SCHEMA_EPOCH, GATEWAY_VERSION } from '../version.js';
import { sendJson } from './route-helpers.js';

const INFO_PATH = '/centraid/_gateway/info';

export interface GatewayInfoRouteOptions {
  /** This process's `GatewayInstanceLease.instanceId` (issue #351). */
  instanceId: string;
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
    return sendJson(res, 200, {
      version: GATEWAY_VERSION,
      schemaEpoch: GATEWAY_SCHEMA_EPOCH,
      startedAt,
      uptimeMs: Date.now() - startedAt,
      instanceId: options.instanceId,
    });
  };
}
