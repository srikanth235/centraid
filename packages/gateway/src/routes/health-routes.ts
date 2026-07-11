/*
 * `GET /centraid/_gateway/health` — component-level health + recent
 * structured errors.
 *
 * `_gateway/info` answers "is a compatible gateway listening"; this
 * route answers "is everything BEHIND the listener actually working" —
 * per-subsystem status (vaults, schedulers, outbox, …), last errors,
 * and a bounded tail of warn/error events, aggregated by the
 * `HealthRegistry` the gateway wires through its subsystems. Behind
 * the host bearer check like every non-public route: health detail
 * (error messages, vault counts) is owner-facing, not liveness-probe
 * material — probes that just need liveness use `_gateway/info`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler } from '../serve/build-gateway.js';
import type { HealthRegistry } from '../serve/health-registry.js';
import { sendError, sendJson } from './route-helpers.js';

const HEALTH_PATH = '/centraid/_gateway/health';

export function makeHealthRouteHandler(health: HealthRegistry): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (url.pathname !== HEALTH_PATH) return false;
    if ((req.method ?? 'GET') !== 'GET') {
      return sendJson(res, 405, { error: 'method_not_allowed', message: 'GET only' });
    }
    try {
      return sendJson(res, 200, await health.snapshot());
    } catch (err) {
      return sendError(res, err);
    }
  };
}
