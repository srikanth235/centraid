// Semantic photo search (#721). Wire field names are a protocol contract. `unavailable` is 200.

import type { IncomingMessage, ServerResponse } from "node:http";

import { searchPhotosByText } from "../enrich/semantic-search.js";
import type { RouteHandler } from "../serve/build-gateway.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import { readJson, sendError, sendJson } from "./route-helpers.js";

export const SEMANTIC_SEARCH_PATH = "/centraid/_vault/enrich/semantic-search";

const MAX_QUERY_CHARS = 512;

export interface EnrichSearchRouteOptions {
  embedQuery?: (query: string) => Promise<{
    outcome?: {
      ok: boolean;
      skipped?: boolean;
      output?: unknown;
      error?: string;
    };
  }>;
}

export function makeEnrichSearchRouteHandler(
  vaults: Pick<VaultRegistry, "current">,
  options: EnrichSearchRouteOptions = {}
): RouteHandler {
  return async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (url.pathname !== SEMANTIC_SEARCH_PATH) return false;
    if ((req.method ?? "GET") !== "POST")
      return sendJson(res, 405, { error: "method_not_allowed" });

    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { error: "invalid_body" });
    }
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query || query.length > MAX_QUERY_CHARS)
      return sendJson(res, 400, { error: "invalid_query" });
    if (body.limit !== undefined && typeof body.limit !== "number")
      return sendJson(res, 400, { error: "invalid_limit" });

    try {
      const outcome = await searchPhotosByText(vaults.current().db, {
        embedQuery: async (text) => {
          if (!options.embedQuery)
            return {
              status: "unavailable",
              reason: "the embed-text automation is unavailable",
            };
          const invoked = await options.embedQuery(text);
          if (!invoked.outcome?.ok && !invoked.outcome?.skipped)
            throw new Error(
              invoked.outcome?.error ?? "the embed-text automation failed"
            );
          if (!invoked.outcome?.ok)
            return {
              status: "unavailable",
              reason:
                invoked.outcome?.error ??
                "the embed-text automation could not run",
            };
          const output = invoked.outcome.output as
            | { model?: unknown; vector?: unknown }
            | undefined;
          if (
            typeof output?.model !== "string" ||
            !Array.isArray(output.vector) ||
            output.vector.some((value) => typeof value !== "number")
          )
            throw new Error("embed-text automation returned an invalid vector");
          return {
            status: "ok",
            model: output.model,
            vector: output.vector as number[],
          };
        },
        query,
        ...(typeof body.limit === "number" ? { limit: body.limit } : {}),
      });
      return sendJson(res, 200, outcome);
    } catch (error) {
      return sendError(res, error);
    }
  };
}
