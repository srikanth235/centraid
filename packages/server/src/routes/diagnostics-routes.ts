/*
 * `GET /centraid/_gateway/diagnostics` — a single JSON document a user
 * can save to a file and hand to support (issue #351, Tier 3).
 *
 * Thin wiring: this module matches the route and gates it. Behind the host
 * bearer check like `_gateway/health` (same reasoning: version/health are
 * one thing, a bundle that includes storage sizes and a log summary is
 * squarely owner-facing, not liveness-probe material).
 *
 * The bundle arrives here ALREADY SERIALIZED, and that is deliberate
 * (#846 P8). The document is built by `serve/support-bundle.ts`, whose last
 * gate is a tripwire sweep over the serialized text for literals harvested
 * from the running system. Handing this route an object to re-serialize
 * would throw that sweep away, so the contract is a string and the route
 * writes exactly the bytes it was given.
 */

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
