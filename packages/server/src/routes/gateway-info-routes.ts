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
  endpointTicket?: () => string | undefined;
}

function isAuthenticated(req: IncomingMessage): boolean {
  return typeof req.headers[AUTHED_PLANE_HEADER] === "string";
}

export function makeGatewayInfoRouteHandler(
  options: GatewayInfoRouteOptions
): RouteHandler {
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
    const authenticated = isAuthenticated(req);
    const endpointTicket = authenticated
      ? options.endpointTicket?.()
      : undefined;
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
