import type { IncomingMessage, ServerResponse } from "node:http";

import type { RouteHandler } from "../serve/build-gateway.js";
import type { HealthRegistry } from "../serve/health-registry.js";
import { sendError, sendJson } from "./route-helpers.js";

const HEALTH_PATH = "/centraid/_gateway/health";

export function makeHealthRouteHandler(health: HealthRegistry): RouteHandler {
  return async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (url.pathname !== HEALTH_PATH) return false;
    if ((req.method ?? "GET") !== "GET") {
      return sendJson(res, 405, {
        error: "method_not_allowed",
        message: "GET only",
      });
    }
    try {
      return sendJson(res, 200, await health.snapshot());
    } catch (error) {
      return sendError(res, error);
    }
  };
}
