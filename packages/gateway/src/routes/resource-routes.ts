/*
 * `POST /centraid/_gateway/resource/pause` + `DELETE …/pause` — the owner's
 * hot-apply "pause background work" control (#528 Phase B).
 *
 * `POST /centraid/_gateway/resource/power-context` + `DELETE …/power-context`
 * — the Electron desktop pushes live host power state (on battery / charging /
 * thermal), which composes into the same safe-loop deferral as the pause
 * (#528 Phase D). Client-pushed state goes stale after 120s (the monitor's
 * own clock enforces it); a DELETE clears it, falling back to the boot probe.
 *
 * A self-hoster on a busy or thermally-throttled machine can suspend the
 * non-urgent background loops (vault sweeps, backup retention) without
 * touching their durable Resource mode. The pause is deliberately
 * runtime-only and in-memory: a restart resumes normally, and this never
 * writes prefs or flips a mode. Durability work — WAL/fsync, the consent
 * outbox — is NEVER gated (see `HealthRegistry.pauseBackgroundWork` and
 * `PowerContextMonitor`).
 *
 * Thin wiring in the same family as `health-routes.ts`: mounted behind the
 * same host bearer gate.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler } from '../serve/build-gateway.js';
import { MAX_BACKGROUND_PAUSE_MS, type HealthRegistry } from '../serve/health-registry.js';
import type {
  PowerContextMonitor,
  PowerContextPushBody,
  ThermalPressure,
} from '../serve/power-context.js';
import { readJson, sendJson } from './route-helpers.js';

const PAUSE_PATH = '/centraid/_gateway/resource/pause';
const POWER_CONTEXT_PATH = '/centraid/_gateway/resource/power-context';

const THERMAL_VALUES: readonly ThermalPressure[] = ['nominal', 'fair', 'serious', 'critical'];

export function makeResourceRouteHandler(
  health: HealthRegistry,
  powerContext?: PowerContextMonitor,
): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (url.pathname === POWER_CONTEXT_PATH) {
      return handlePowerContext(req, res, powerContext);
    }
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

async function handlePowerContext(
  req: IncomingMessage,
  res: ServerResponse,
  powerContext: PowerContextMonitor | undefined,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (!powerContext) {
    return sendJson(res, 503, { error: 'unavailable', message: 'power context not wired' });
  }
  if (method === 'DELETE') {
    powerContext.clearClientPush();
    return sendJson(res, 200, { ok: true });
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

  const parsed = parsePowerContextBody(body);
  if ('error' in parsed) {
    return sendJson(res, 400, { error: 'invalid_body', message: parsed.error });
  }
  powerContext.applyClientPush(parsed.body);
  return sendJson(res, 200, { ok: true });
}

/** Strict validation — garbage is a 400, not a coerced push. */
function parsePowerContextBody(
  body: Record<string, unknown>,
): { body: PowerContextPushBody } | { error: string } {
  if (typeof body.onBattery !== 'boolean') {
    return { error: 'onBattery must be a boolean' };
  }
  const push: PowerContextPushBody = { onBattery: body.onBattery };

  if (body.batteryPercent !== undefined && body.batteryPercent !== null) {
    const p = body.batteryPercent;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100) {
      return { error: 'batteryPercent must be a number in [0, 100] or null' };
    }
    push.batteryPercent = p;
  }

  if (body.charging !== undefined && body.charging !== null) {
    if (typeof body.charging !== 'boolean') return { error: 'charging must be a boolean or null' };
    push.charging = body.charging;
  }

  if (body.thermalPressure !== undefined && body.thermalPressure !== null) {
    if (!THERMAL_VALUES.includes(body.thermalPressure as ThermalPressure)) {
      return { error: `thermalPressure must be one of ${THERMAL_VALUES.join(', ')} or null` };
    }
    push.thermalPressure = body.thermalPressure as ThermalPressure;
  }

  return { body: push };
}
