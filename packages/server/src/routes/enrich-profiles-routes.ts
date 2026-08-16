// The engine-profile read surface (issue #807, Wave 1).
//
//   GET /centraid/_enrich/profiles → { profiles: EngineProfile[] }
//
// One list, built-ins first, each carrying its COMPUTED egress class and its
// built-in flag. Settings renders off these fields and never off a local table
// keyed on capability or harness ids it happens to know (docs/protocol.md C1a),
// so a gateway that ships a new capability lists it without a client release.
//
// READ ONLY, AND DELIBERATELY CHEAP. Writes go through the generic prefs API
// (`PUT /_centraid-user/prefs`, keys `enrich.profile.<id>`), which is where the
// one validation gate lives — a second write path here would be a second
// validator to keep in sync. And nothing on this path spawns: harness
// AVAILABILITY is `/centraid/_harnesses/status`'s question, answered there by a
// probe with its own 24h cache, so a Settings page that wants both asks both
// rather than making a profile list fork a process per registered harness.

import type { IncomingMessage, ServerResponse } from "node:http";

import { listEngineProfiles } from "../enrich/engine-profiles.js";
import type { EngineProfileReadOptions } from "../enrich/engine-profiles.js";
import type { RouteHandler } from "../serve/build-gateway.js";
import { sendJson } from "./route-helpers.js";

export const ENRICH_PROFILES_PREFIX = "/centraid/_enrich";
export const ENRICH_PROFILES_PATH = "/centraid/_enrich/profiles";

export interface EnrichProfilesRouteOptions extends EngineProfileReadOptions {
  /** The gateway's prefs snapshot — profiles are gateway config, not vault state. */
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
