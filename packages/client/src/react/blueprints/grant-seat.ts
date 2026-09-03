import {
  grantWireCalls,
  queuedGrantWireCalls,
} from "@centraid/blueprints/apps/_shared/grant-transport";
import type {
  GrantHttp,
  GrantIntentQueue,
  GrantWireCalls,
  QueuedGrantWireCalls,
} from "@centraid/blueprints/apps/_shared/grant-transport";

import { authHeaders, doFetch } from "../../gateway-client-core.js";
import type { GatewayAuth } from "../../gateway-client-core.js";
import { openGrantIntentQueue } from "./grant-queue-store.js";

export type GrantBridge = GrantWireCalls;

function seatHttp(auth: () => Promise<GatewayAuth>): GrantHttp {
  return {
    async get(pathname) {
      const gatewayAuth = await auth();
      return doFetch(gatewayAuth.baseUrl, pathname, {
        headers: authHeaders(gatewayAuth.token),
      });
    },
    async post(pathname, payload) {
      const gatewayAuth = await auth();
      return doFetch(gatewayAuth.baseUrl, pathname, {
        method: "POST",
        headers: authHeaders(gatewayAuth.token, "application/json"),
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
    },
  };
}

export function grantBridge(auth: () => Promise<GatewayAuth>): GrantBridge {
  return grantWireCalls(seatHttp(auth));
}

export async function queuedGrantBridge(
  auth: () => Promise<GatewayAuth>,
  queue?: GrantIntentQueue
): Promise<QueuedGrantWireCalls | GrantBridge> {
  const store = queue ?? (await openGrantIntentQueue());
  const calls = grantWireCalls(seatHttp(auth));
  return store ? queuedGrantWireCalls(calls, store) : calls;
}
