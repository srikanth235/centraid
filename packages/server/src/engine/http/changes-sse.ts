/*
 * The change bus's HTTP face; auth belongs to the surrounding HTTP server. The
 * shells consume the bus over their own transports, so the absence of an
 * in-repo subscriber is not evidence this surface is dead.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { ChangeBus } from "../changes/change-bus.js";
import { sendJson } from "./http-utils.js";
import { SseStream } from "./sse-stream.js";

// Stay under the ~60s idle cut of mobile NATs and reverse proxies (#404).
const HEARTBEAT_MS = 55_000;

/** Per appId, never global (#351): one app must not starve the others. */
export const CHANGES_SSE_MAX_SUBSCRIBERS_PER_APP = 16;

const CHANGES_SSE_RETRY_AFTER_SECONDS = 5;

export class ChangesSubscriberCap {
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly max: number = CHANGES_SSE_MAX_SUBSCRIBERS_PER_APP
  ) {}

  current(appId: string): number {
    return this.counts.get(appId) ?? 0;
  }

  total(): number {
    let sum = 0;
    for (const count of this.counts.values()) sum += count;
    return sum;
  }

  /** Release exactly once; `undefined` means a 503 was already written. */
  admit(appId: string, res: ServerResponse): (() => void) | undefined {
    const count = this.counts.get(appId) ?? 0;
    if (count >= this.max) {
      res.setHeader("Retry-After", String(CHANGES_SSE_RETRY_AFTER_SECONDS));
      sendJson(res, 503, {
        error: "sse_capacity",
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

const sharedChangesCap = new ChangesSubscriberCap();

export function changesSubscriberCount(): number {
  return sharedChangesCap.total();
}

export async function handleAppChanges(
  req: IncomingMessage,
  res: ServerResponse,
  bus: ChangeBus,
  appId: string,
  cap: ChangesSubscriberCap = sharedChangesCap
): Promise<void> {
  const release = cap.admit(appId, res);
  if (!release) return;

  // `X-Accel-Buffering: no` defeats nginx response buffering.
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // Bounded writer (#659): a subscriber that stops reading is dropped.
  const stream = new SseStream(res);
  // Fires the client's `onopen` without waiting for a real event.
  stream.comment(`connected to ${appId}`);

  const unsubscribe = bus.subscribe(appId, (_change, serialized) => {
    stream.event("change", serialized);
  });

  const heartbeat = setInterval(() => {
    stream.comment("ping");
  }, HEARTBEAT_MS);
  // The SSE socket owns the lifetime; don't block process exit.
  heartbeat.unref?.();

  // Resolve only on disconnect, so the HTTP server keeps the socket open, and
  // listen on the request socket: some proxies half-close oddly. Events race.
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
      // oxlint-disable-next-line promise/no-multiple-resolved -- `done` guard ensures single resolution (#247)
      resolve();
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
    res.on("close", cleanup);
  });
}
