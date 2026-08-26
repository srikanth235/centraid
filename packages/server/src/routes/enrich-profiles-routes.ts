// Engine-profile read surface (#807). READ ONLY, nothing here spawns:
// writes go through the prefs API's single validation gate.

import type { IncomingMessage, ServerResponse } from "node:http";

import { listEngineProfiles } from "../enrich/engine-profiles.js";
import type { EngineProfileReadOptions } from "../enrich/engine-profiles.js";
import type { RouteHandler } from "../serve/build-gateway.js";
import { sendJson } from "./route-helpers.js";

export const ENRICH_PROFILES_PREFIX = "/centraid/_enrich";
export const ENRICH_PROFILES_PATH = "/centraid/_enrich/profiles";

export interface EnrichProfilesRouteOptions extends EngineProfileReadOptions {
  readonly readPrefs: () => Record<string, unknown>;
}

export function makeEnrichProfilesRouteHandler(
  options: EnrichProfilesRouteOptions
): RouteHandler {
  const { readPrefs, ...readOptions } = options;
  return async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (url.pathname !== ENRICH_PROFILES_PATH) return false;
    if ((req.method ?? "GET") !== "GET")
      return sendJson(res, 405, { error: "method_not_allowed" });
    return sendJson(res, 200, {
      profiles: listEngineProfiles(readPrefs(), readOptions),
    });
  };
}
