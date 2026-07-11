/*
 * Gateway log routes — the wire surface over `GatewayLogStore`.
 *
 *   GET /centraid/_logs              one-shot JSON tail ({ entries }),
 *                                    `?after=<seq>` resume + `?limit=<n>` cap
 *   GET /centraid/_logs/events       SSE: replay the buffer (honoring
 *                                    `?after=`), then stream live lines
 *                                    until the client disconnects
 *
 * Mounted in `buildGateway`'s `extraHandlers`, so the app-engine bearer
 * check runs before it (cf. http-server.ts) — logs never leave the
 * gateway unauthenticated. The SSE mechanics (headers, heartbeat,
 * idempotent cleanup) mirror the automation run stream in
 * `automations-routes.ts`; unlike a run there is no terminal event —
 * the stream lives until the viewer goes away.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler } from '../serve/build-gateway.js';
import type { GatewayLogEntry, GatewayLogStore } from '../serve/gateway-log-store.js';
import { sendJson } from './route-helpers.js';
import { SseSubscriberCap } from './sse-cap.js';

const LOGS_PATH = '/centraid/_logs';
const EVENTS_PATH = '/centraid/_logs/events';

/** Default + max entry counts for the one-shot JSON tail. */
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

/**
 * The production subscriber cap for `/centraid/_logs/events` — one gateway
 * process serves one of these (`buildGateway` calls `makeLogsRouteHandler`
 * with no override), so this instance's live count IS the real count.
 */
const defaultSubscriberCap = new SseSubscriberCap();

/** Live subscriber count on the gateway-logs SSE stream (issue #351). */
export function logsEventsSubscriberCount(): number {
  return defaultSubscriberCap.current();
}

function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

export interface LogsRouteOptions {
  /** Overridable for tests; production callers take the shared default. */
  subscriberCap?: SseSubscriberCap;
}

export function makeLogsRouteHandler(
  logs: GatewayLogStore,
  options: LogsRouteOptions = {},
): RouteHandler {
  const subscriberCap = options.subscriberCap ?? defaultSubscriberCap;

  const streamLogEvents = (
    req: IncomingMessage,
    res: ServerResponse,
    afterSeq: number,
  ): boolean => {
    const releaseSlot = subscriberCap.admit(res);
    if (!releaseSlot) return true; // 503 + Retry-After already written

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`: gateway logs\n\n`);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(`: ping\n\n`);
    }, 30_000);
    heartbeat.unref?.();

    let closed = false;
    let unsub = (): void => undefined;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsub();
      releaseSlot();
      if (!res.writableEnded) res.end();
    };
    req.on('close', cleanup);
    res.on('error', cleanup);

    const write = (entry: GatewayLogEntry): void => {
      if (res.writableEnded) return;
      res.write(`event: log\n`);
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    };

    // Replay then live. Both are synchronous against the in-process store,
    // so no line can land between the snapshot and the subscribe — the
    // client sees a gapless, `seq`-ordered stream.
    for (const entry of logs.snapshot(afterSeq)) write(entry);
    unsub = logs.subscribe(write);
    return true;
  };

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (url.pathname !== LOGS_PATH && url.pathname !== EVENTS_PATH) return false;
    if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
      return sendJson(res, 405, { error: 'method_not_allowed', message: 'GET only' });
    }
    const after = intParam(url, 'after') ?? 0;

    if (url.pathname === EVENTS_PATH) return streamLogEvents(req, res, after);

    const limit = Math.min(intParam(url, 'limit') ?? DEFAULT_LIMIT, MAX_LIMIT);
    const entries = logs.snapshot(after);
    // Tail semantics: past the cap, the NEWEST `limit` entries win.
    return sendJson(res, 200, {
      entries: entries.length > limit ? entries.slice(entries.length - limit) : entries,
    });
  };
}
