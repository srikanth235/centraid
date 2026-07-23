/*
 * `POST /centraid/_gateway/resource/pause` + `DELETE …/pause` — the owner's
 * hot-apply "pause background work" control (#528 Phase B).
 *
 * A self-hoster on a busy or thermally-throttled machine can suspend the
 * non-urgent background loops (vault sweeps, backup retention) without
 * touching their durable Resource mode. The pause is deliberately
 * runtime-only and in-memory: a restart resumes normally, and this never
 * writes prefs or flips a mode. Durability work — WAL/fsync, the consent
 * outbox — is NEVER gated (see `HealthRegistry.pauseBackgroundWork`).
 *
 * Thin wiring in the same family as `health-routes.ts`: mounted behind the
 * same host bearer gate. POST pauses (optional bounded `durationMs`), DELETE
 * resumes; any other method is 405.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler } from '../serve/build-gateway.js';
import { MAX_BACKGROUND_PAUSE_MS, type HealthRegistry } from '../serve/health-registry.js';
import { readJson, sendJson } from './route-helpers.js';

const PAUSE_PATH = '/centraid/_gateway/resource/pause';

export function makeResourceRouteHandler(health: HealthRegistry): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (url.pathname !== PAUSE_PATH) return false;

    const method = req.method ?? 'GET';
    if (method === 'DELETE') {
      const state = health.resumeBackgroundWork();
      return sendJson(res, 200, { paused: state.paused });
    }
    if (method !== 'POST') {
      return sendJson(res, 405, { error: 'method_not_allowed', message: 'POST, DELETE only' });
    }

    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, {
        error: 'invalid_body',
        message: err instanceof Error ? err.message : String(err),
      });
    }

    const raw = body.durationMs;
    let durationMs: number | undefined;
    if (raw !== undefined && raw !== null) {
      if (
        typeof raw !== 'number' ||
        !Number.isInteger(raw) ||
        raw <= 0 ||
        raw > MAX_BACKGROUND_PAUSE_MS
      ) {
        return sendJson(res, 400, {
          error: 'invalid_duration',
          message: `durationMs must be a positive integer of milliseconds ≤ ${MAX_BACKGROUND_PAUSE_MS} (24h)`,
        });
      }
      durationMs = raw;
    }

    const state = health.pauseBackgroundWork(durationMs);
    return sendJson(res, 200, { paused: true, until: state.until });
  };
}
