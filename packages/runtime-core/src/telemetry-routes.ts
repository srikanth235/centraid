/*
 * HTTP routes for the telemetry store.
 *
 * Mounted by hosts at `/_centraid-telemetry`. Event writes happen
 * in-process via `TelemetryWriter` — there is no public event-write
 * endpoint. The settings PUT is the one exception, since per-app
 * controls are a user-facing knob.
 *
 * Routes:
 *   GET  /_centraid-telemetry/events?appId=...&limit=&sinceTs=&level=
 *   GET  /_centraid-telemetry/settings?appId=...
 *   PUT  /_centraid-telemetry/settings   body: {appId, enabled?, minLevel?, retentionDaysOverrides?}
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  TelemetryAppSettings,
  TelemetryAppSettingsPatch,
  TelemetryLevel,
} from './telemetry.js';
import type { TelemetryStore } from './telemetry-store.js';

const ROUTE_PREFIX = '/_centraid-telemetry';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text).toString(),
  });
  res.end(text);
}

function sendErr(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function parseIntOpt(s: string | null): number | undefined {
  if (!s) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

function isLevel(s: string | null): s is TelemetryLevel {
  return s === 'info' || s === 'warn' || s === 'error';
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  return JSON.parse(text) as unknown;
}

function parseSettingsPatch(body: {
  enabled?: unknown;
  minLevel?: unknown;
  retentionDaysOverrides?: unknown;
}): TelemetryAppSettingsPatch {
  const patch: TelemetryAppSettingsPatch = {};
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (isLevel(body.minLevel as string | null)) {
    patch.minLevel = body.minLevel as TelemetryLevel;
  }
  if (body.retentionDaysOverrides && typeof body.retentionDaysOverrides === 'object') {
    const raw = body.retentionDaysOverrides as Record<string, unknown>;
    const out: NonNullable<TelemetryAppSettings['retentionDaysOverrides']> = {};
    const keys = ['eventInfo', 'eventWarn', 'eventError', 'spanOk', 'spanErr'] as const;
    for (const k of keys) {
      const v = raw[k];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = Math.floor(v);
    }
    patch.retentionDaysOverrides = Object.keys(out).length > 0 ? out : undefined;
  }
  return patch;
}

export function makeTelemetryRouteHandler(getStore: () => TelemetryStore) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (!req.url || !req.url.startsWith(ROUTE_PREFIX)) return false;
    const url = new URL(req.url, 'http://x');
    const sub = url.pathname.slice(ROUTE_PREFIX.length);
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      if (sub === '/events' || sub === '/events/') {
        if (method !== 'GET') {
          sendErr(res, 405, 'method not allowed');
          return true;
        }
        const appId = url.searchParams.get('appId');
        if (!appId) {
          sendErr(res, 400, 'appId is required');
          return true;
        }
        const limit = parseIntOpt(url.searchParams.get('limit'));
        const sinceTs = parseIntOpt(url.searchParams.get('sinceTs'));
        const levelParam = url.searchParams.get('level');
        const level = isLevel(levelParam) ? levelParam : undefined;
        const entries = await getStore().readEvents(appId, { limit, sinceTs, level });
        sendJson(res, 200, { entries });
        return true;
      }

      if (sub === '/settings' || sub === '/settings/') {
        if (method === 'GET') {
          const appId = url.searchParams.get('appId');
          if (!appId) {
            sendErr(res, 400, 'appId is required');
            return true;
          }
          const settings = await getStore().getAppSettings(appId);
          sendJson(res, 200, settings);
          return true;
        }
        if (method === 'PUT') {
          const body = (await readJsonBody(req)) as
            | {
                appId?: string;
                enabled?: unknown;
                minLevel?: unknown;
                retentionDaysOverrides?: unknown;
              }
            | undefined;
          if (!body?.appId || typeof body.appId !== 'string') {
            sendErr(res, 400, 'appId is required');
            return true;
          }
          const updated = await getStore().setAppSettings(body.appId, parseSettingsPatch(body));
          sendJson(res, 200, updated);
          return true;
        }
        sendErr(res, 405, 'method not allowed');
        return true;
      }

      sendErr(res, 404, 'unknown telemetry route');
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendErr(res, 500, msg);
      return true;
    }
  };
}
