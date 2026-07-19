import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler } from '../serve/build-gateway.js';
import { readJson, sendJson } from './route-helpers.js';

export const DATA_PLANE_AUTHORIZE_PATH = '/centraid/_gateway/tunnel/authorize';
export const DATA_PLANE_PAIR_PATH = '/centraid/_gateway/tunnel/pair';

export interface DataPlaneControlOptions {
  secret: string;
  authorize(endpointId: string): { allowed: boolean; headers?: Record<string, string> };
  pair(request: unknown, endpointId: string): unknown | Promise<unknown>;
}

function matchesSecret(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function makeDataPlaneControlHandler(options: DataPlaneControlOptions): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    const authorize = url.pathname === DATA_PLANE_AUTHORIZE_PATH;
    const pair = url.pathname === DATA_PLANE_PAIR_PATH;
    if (!authorize && !pair) return false;
    const supplied = req.headers['x-centraid-data-plane-secret'];
    const candidate = Array.isArray(supplied) ? supplied[0] : supplied;
    if (!matchesSecret(candidate, options.secret)) {
      return sendJson(res, 403, { error: 'invalid_data_plane_secret' });
    }
    const endpointId = url.searchParams.get('endpointId');
    if (!endpointId) return sendJson(res, 400, { error: 'endpointId_required' });
    const method = (req.method ?? 'GET').toUpperCase();
    if (authorize) {
      if (method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
      return sendJson(res, 200, options.authorize(endpointId));
    }
    if (method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
    return sendJson(res, 200, await options.pair(await readJson(req), endpointId));
  };
}
