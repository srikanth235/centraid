/*
 * `GET /centraid/_gateway/info` — identity + version handshake (#289/#504).
 * Read BEFORE trusting a gateway: schema epoch (exact-match or refuse in v0),
 * capabilities (C1), device vault addressing, runtime clock.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { ROUTES, buildGatewayInfoPayload } from "@centraid/core/protocol";
import type { GatewayCapabilities } from "@centraid/core/protocol";
import { AUTHED_PLANE_HEADER } from "@centraid/server/engine";

import type { RouteHandler } from "../serve/build-gateway.js";
import { sendJson } from "./route-helpers.js";

const INFO_PATH = ROUTES.gatewayInfo;

export interface GatewayInfoRouteOptions {
  instanceId: string;
  capabilities?: GatewayCapabilities;
  endpointId?: () => string | undefined;
  /** Dial ticket — served ONLY with a valid credential (#568); the route
   *  itself is public and loopback origin is NOT authentication. */
  endpointTicket?: () => string | undefined;
}

/** `AUTHED_PLANE_HEADER` is stamped server-side and stripped inbound: unforgable. */
function isAuthenticated(req: IncomingMessage): boolean {
  return typeof req.headers[AUTHED_PLANE_HEADER] === "string";
}

export function makeGatewayInfoRouteHandler(
  options: GatewayInfoRouteOptions
): RouteHandler {
  // Factory runs once inside buildGateway: process start.
  const startedAt = Date.now();
  return async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (url.pathname !== INFO_PATH) return false;
    if ((req.method ?? "GET") !== "GET") {
      return sendJson(res, 405, {
        error: "method_not_allowed",
        message: "GET only",
      });
    }
    const endpointId = options.endpointId?.();
    // Reported on the payload (#603): a lost ticket must not read like
    // "endpoint not yet up".
    const authenticated = isAuthenticated(req);
    const endpointTicket = authenticated
      ? options.endpointTicket?.()
      : undefined;
    // The stable EndpointId is a dial address: serving it to anonymous
    // callers turns the public handshake into a presence oracle and hands
    // out a fingerprintable permanent identity (issue #865) — same gate as
    // the ticket.
    return sendJson(
      res,
      200,
      buildGatewayInfoPayload({
        instanceId: options.instanceId,
        startedAt,
        uptimeMs: Date.now() - startedAt,
        authenticated,
        ...(authenticated && endpointId !== undefined ? { endpointId } : {}),
        ...(endpointTicket === undefined ? {} : { endpointTicket }),
        ...(options.capabilities ? { capabilities: options.capabilities } : {}),
      })
    );
  };
}
