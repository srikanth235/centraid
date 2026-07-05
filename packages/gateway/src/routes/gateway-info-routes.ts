/*
 * `GET /centraid/_gateway/info` — gateway identity + version handshake
 * (issue #289).
 *
 * The one route a client reads BEFORE trusting anything else about a
 * gateway: software version + schema epoch (exact-match or refuse in v0)
 * and, for device-scoped transports, which vaults the calling device may
 * address (the composed handler already resolved that; this route is behind
 * it). Static JSON — health polling hits it every few seconds.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler } from '../serve/build-gateway.js';
import { GATEWAY_SCHEMA_EPOCH, GATEWAY_VERSION } from '../version.js';
import { sendJson } from './route-helpers.js';

const INFO_PATH = '/centraid/_gateway/info';

export function makeGatewayInfoRouteHandler(): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (url.pathname !== INFO_PATH) return false;
    if ((req.method ?? 'GET') !== 'GET') {
      return sendJson(res, 405, { error: 'method_not_allowed', message: 'GET only' });
    }
    return sendJson(res, 200, {
      version: GATEWAY_VERSION,
      schemaEpoch: GATEWAY_SCHEMA_EPOCH,
    });
  };
}
