import type { IncomingMessage, ServerResponse } from "node:http";

import type { RouteHandler } from "../serve/build-gateway.js";
import { sendError, sendJson, sendJsonText } from "./route-helpers.js";

const DIAGNOSTICS_PATH = "/centraid/_gateway/diagnostics";

export function makeDiagnosticsRouteHandler(
  build: () => Promise<string>
): RouteHandler {
  return async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (url.pathname !== DIAGNOSTICS_PATH) return false;
    if ((req.method ?? "GET") !== "GET") {
      return sendJson(res, 405, {
        error: "method_not_allowed",
        message: "GET only",
      });
    }
    try {
      return sendJsonText(res, 200, await build());
    } catch (error) {
      return sendError(res, error);
    }
  };
}
