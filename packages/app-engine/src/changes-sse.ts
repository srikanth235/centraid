/*
 * Server-Sent Events endpoint for app-scoped change notifications.
 *
 * Wire format (one event per line of `data:`):
 *
 *     event: change
 *     data: {"tables":["todos"],"ts":1715812345678}
 *
 * Plus a periodic heartbeat comment line (`: ping\n\n`) every 30s so
 * proxies / browsers don't time the idle connection out. The client side
 * pattern in app code is just:
 *
 *     const es = new EventSource('/centraid/<id>/_changes');
 *     es.addEventListener('change', (e) => {
 *       const { tables } = JSON.parse(e.data);
 *       // re-fetch your queries that touch these tables
 *     });
 *
 * Auth lives in the surrounding HTTP server (loopback bearer for the
 * embedded local runtime, gateway auth for the OpenClaw plugin). For the
 * desktop iframe specifically, Electron's `webRequest.onBeforeSendHeaders`
 * injects the bearer token automatically — `EventSource` doesn't support
 * custom headers natively but it doesn't need to.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChangeBus } from './change-bus.js';

const HEARTBEAT_MS = 30_000;

export async function handleAppChanges(
  req: IncomingMessage,
  res: ServerResponse,
  bus: ChangeBus,
  appId: string,
): Promise<void> {
  // SSE handshake — keep-alive is essential or browsers close after a few
  // seconds of no body. `X-Accel-Buffering: no` disables nginx response
  // buffering for deployments behind a reverse proxy.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Send an initial comment so the client's `onopen` fires immediately
  // instead of waiting for the first real event.
  res.write(`: connected to ${appId}\n\n`);

  const unsubscribe = bus.subscribe(appId, (change) => {
    if (res.writableEnded) return;
    res.write(`event: change\n`);
    const payload: Record<string, unknown> = {
      tables: change.tables,
      ts: change.ts,
      source: change.source,
    };
    if (change.toolCallId) payload.toolCallId = change.toolCallId;
    if (change.agentTurnId) payload.agentTurnId = change.agentTurnId;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  });

  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    res.write(`: ping\n\n`);
  }, HEARTBEAT_MS);
  // Don't block process exit waiting on the heartbeat; the SSE socket
  // owns the lifetime here.
  heartbeat.unref?.();

  // Resolve the handler promise only when the client disconnects so the
  // surrounding HTTP server keeps the socket open. We listen on the
  // request socket (not res) because some proxies half-close in odd ways.
  // Three events can trigger cleanup (req close, req error, res close)
  // and any of them can race — the `done` guard makes unsubscribe + the
  // promise resolution idempotent across them.
  await new Promise<void>((resolve) => {
    let done = false;
    const cleanup = (): void => {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      unsubscribe();
      if (!res.writableEnded) {
        try {
          res.end();
        } catch {
          /* swallow */
        }
      }
      // eslint-disable-next-line promise/no-multiple-resolved -- `done` guard ensures single resolution
      resolve();
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
  });
}
