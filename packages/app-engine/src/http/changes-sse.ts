/*
 * Server-Sent Events endpoint for app-scoped change notifications.
 *
 * Wire format (one event per line of `data:`):
 *
 *     event: change
 *     data: {"tables":["todos"],"ts":1715812345678}
 *
 * Plus a periodic heartbeat comment line (`: ping\n\n`) every 55s so
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
 * embedded local runtime, gateway auth for the standalone daemon). For the
 * desktop iframe specifically, Electron's `webRequest.onBeforeSendHeaders`
 * injects the bearer token automatically — `EventSource` doesn't support
 * custom headers natively but it doesn't need to.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChangeBus } from '../changes/change-bus.js';
import { sendJson } from './http-utils.js';

// 55s keeps the stream warm while staying under the ~60s idle cut common to
// mobile carrier NATs and reverse proxies (issue #404) — one heartbeat still
// lands inside every idle window, at roughly half the wakeups of the old 30s.
const HEARTBEAT_MS = 55_000;

/**
 * Concurrent `_changes` subscribers a single app accepts (issue #351 Tier 4
 * hygiene). Unlike the gateway's per-surface SSE caps (one `_logs` stream,
 * one `_automations` stream, a handful of devices), `_changes` is per-app
 * and a user can legitimately have several windows/tabs of the SAME app
 * open — so the cap is scoped PER APPID, not global: a runaway reconnect
 * loop in one app's injected script can't starve every other app's stream.
 */
export const CHANGES_SSE_MAX_SUBSCRIBERS_PER_APP = 16;

/** Seconds a refused client should wait before retrying (`Retry-After`). */
const CHANGES_SSE_RETRY_AFTER_SECONDS = 5;

/** Per-appId concurrent-subscriber cap for `_changes` streams. */
export class ChangesSubscriberCap {
  private readonly counts = new Map<string, number>();

  constructor(private readonly max: number = CHANGES_SSE_MAX_SUBSCRIBERS_PER_APP) {}

  /** Live subscriber count for one app (0 if never subscribed). */
  current(appId: string): number {
    return this.counts.get(appId) ?? 0;
  }

  /** Live subscriber count summed across every app — for a health/metrics surface to poll. */
  total(): number {
    let sum = 0;
    for (const count of this.counts.values()) sum += count;
    return sum;
  }

  /**
   * Try to admit one subscriber for `appId`. On success increments that
   * app's live count and returns a release function the caller MUST invoke
   * exactly once when the stream ends (close/error). On saturation writes a
   * `503` JSON error with `Retry-After` onto `res` and returns `undefined`
   * — the caller must not write a stream response afterward.
   */
  admit(appId: string, res: ServerResponse): (() => void) | undefined {
    const count = this.counts.get(appId) ?? 0;
    if (count >= this.max) {
      res.setHeader('Retry-After', String(CHANGES_SSE_RETRY_AFTER_SECONDS));
      sendJson(res, 503, {
        error: 'sse_capacity',
        message: `too many concurrent _changes subscribers for this app (max ${this.max}) — retry shortly`,
      });
      return undefined;
    }
    this.counts.set(appId, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = Math.max(0, (this.counts.get(appId) ?? 0) - 1);
      if (next === 0) this.counts.delete(appId);
      else this.counts.set(appId, next);
    };
  }
}

// One cap for the process's lifetime, shared by every `handleAppChanges`
// call — mirrors the gateway's per-surface module-level cap instances.
// `changesSubscriberCount()` lets a host's health/metrics surface poll the
// live total without owning the cap instance itself.
const sharedChangesCap = new ChangesSubscriberCap();

/** Live `_changes` subscriber count across every app, for health/metrics. */
export function changesSubscriberCount(): number {
  return sharedChangesCap.total();
}

export async function handleAppChanges(
  req: IncomingMessage,
  res: ServerResponse,
  bus: ChangeBus,
  appId: string,
  cap: ChangesSubscriberCap = sharedChangesCap,
): Promise<void> {
  const release = cap.admit(appId, res);
  if (!release) return;

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
    if (change.turnId) payload.turnId = change.turnId;
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
      release();
      if (!res.writableEnded) {
        try {
          res.end();
        } catch {
          /* swallow */
        }
      }
      // eslint-disable-next-line promise/no-multiple-resolved -- `done` guard ensures single resolution (#247)
      resolve();
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
  });
}
