// The native seat's half of the grant transport — only the base URL and this
// phone's own device credential differ from the browser seat's (#883).

import { grantDoor } from "@centraid/blueprints/apps/_shared/grant-door";
import type { GrantDoor } from "@centraid/blueprints/apps/_shared/grant-door";
import {
  grantWireCalls,
  queuedGrantWireCalls,
} from "@centraid/blueprints/apps/_shared/grant-transport";
import type {
  GrantHttp,
  GrantIntentQueue,
  QueuedGrantWireCalls,
} from "@centraid/blueprints/apps/_shared/grant-transport";

import { apiHeaders } from "../../lib/gateway";
import { nativeGrantIntentQueue } from "./grant-queue-store";

export function nativeGrantHttp(baseUrl: string): GrantHttp {
  return {
    get: (pathname) =>
      fetch(new URL(pathname, baseUrl), { headers: apiHeaders() }),
    post: (pathname, payload) =>
      fetch(new URL(pathname, baseUrl), {
        method: "POST",
        headers: apiHeaders(
          payload === undefined ? {} : { "content-type": "application/json" }
        ),
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      }),
  };
}

/** The offline queue sits in front of the two writes. */
export function nativeGrantDoor(
  baseUrl: string,
  queue: GrantIntentQueue = nativeGrantIntentQueue()
): GrantDoor {
  return grantDoor(nativeGrantWire(baseUrl, queue));
}

export function nativeGrantWire(
  baseUrl: string,
  queue: GrantIntentQueue = nativeGrantIntentQueue()
): QueuedGrantWireCalls {
  return queuedGrantWireCalls(grantWireCalls(nativeGrantHttp(baseUrl)), queue);
}
