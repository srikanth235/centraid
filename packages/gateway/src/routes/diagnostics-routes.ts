/*
 * `GET /centraid/_gateway/diagnostics` — a single JSON document a user
 * can save to a file and hand to support (issue #351, Tier 3).
 *
 * Thin wiring over `gateway-diagnostics.ts`'s `buildDiagnosticsBundle` —
 * this module just matches the route and gates it. Behind the host
 * bearer check like `_gateway/health` (same reasoning: version/health
 * are one thing, a bundle that includes vault sizes and a log tail is
 * squarely owner-facing, not liveness-probe material).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler } from '../serve/build-gateway.js';
import type { DiagnosticsBundle } from '../serve/gateway-diagnostics.js';
import { sendError, sendJson } from './route-helpers.js';

const DIAGNOSTICS_PATH = '/centraid/_gateway/diagnostics';

export function makeDiagnosticsRouteHandler(build: () => Promise<DiagnosticsBundle>): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (url.pathname !== DIAGNOSTICS_PATH) return false;
    if ((req.method ?? 'GET') !== 'GET') {
      return sendJson(res, 405, { error: 'method_not_allowed', message: 'GET only' });
    }
    try {
      return sendJson(res, 200, await build());
    } catch (err) {
      return sendError(res, err);
    }
  };
}
