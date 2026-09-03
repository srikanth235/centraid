import type { IncomingMessage, ServerResponse } from "node:http";

import { SseStream } from "@centraid/server/engine";

import { unrefTimer } from "../lib/unref-timer.js";
import type { RouteHandler } from "../serve/build-gateway.js";
import type {
  GatewayLogEntry,
  GatewayLogStore,
} from "../serve/gateway-log-store.js";
import { sendJson } from "./route-helpers.js";
import { SseSubscriberCap } from "./sse-cap.js";

const LOGS_PATH = "/centraid/_logs";
const EVENTS_PATH = "/centraid/_logs/events";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

const defaultSubscriberCap = new SseSubscriberCap();

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
  subscriberCap?: SseSubscriberCap;
}

export function makeLogsRouteHandler(
  logs: GatewayLogStore,
  options: LogsRouteOptions = {}
): RouteHandler {
  const subscriberCap = options.subscriberCap ?? defaultSubscriberCap;

  const streamLogEvents = (
    req: IncomingMessage,
    res: ServerResponse,
    afterSeq: number
  ): boolean => {
    const releaseSlot = subscriberCap.admit(res);
    if (!releaseSlot) return true; // 503 + Retry-After already written

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const stream = new SseStream(res);
    stream.comment("gateway logs");
    const heartbeat = setInterval(() => {
      stream.comment("ping");
    }, 30_000);
    unrefTimer(heartbeat);

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
    req.on("close", cleanup);
    res.on("error", cleanup);

    const write = (
      entry: GatewayLogEntry,
      serialized = JSON.stringify(entry)
    ): void => {
      stream.event("log", serialized);
    };

    for (const entry of logs.snapshot(afterSeq)) write(entry);
    unsub = logs.subscribe(write);
    return true;
  };

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (url.pathname !== LOGS_PATH && url.pathname !== EVENTS_PATH)
      return false;
    if ((req.method ?? "GET").toUpperCase() !== "GET") {
      return sendJson(res, 405, {
        error: "method_not_allowed",
        message: "GET only",
      });
    }
    const after = intParam(url, "after") ?? 0;

    if (url.pathname === EVENTS_PATH) return streamLogEvents(req, res, after);

    const limit = Math.min(intParam(url, "limit") ?? DEFAULT_LIMIT, MAX_LIMIT);
    const entries = logs.snapshot(after);
    return sendJson(res, 200, {
      entries:
        entries.length > limit
          ? entries.slice(entries.length - limit)
          : entries,
    });
  };
}
