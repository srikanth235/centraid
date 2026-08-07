// Semantic photo search over HTTP (issue #721 E3) — the owner's query plane
// onto `enrich_embedding`.
//
//   POST /centraid/_vault/enrich/semantic-search
//        body {query: string, limit?: number}
//     -> 200 {status:"ok", model, hits:[{assetId, contentId, score}]}
//     -> 200 {status:"unavailable", reason}
//
// THE WIRE SHAPE IS A CONTRACT. The mobile Photos surface renders exactly
// these field names; changing one is a protocol change, not a rename (see
// docs/protocol.md C1 — the two-contract rule).
//
// `unavailable` IS A 200. A gateway with no embedder configured, or one whose
// index is still empty, is not broken and its member is not looking at an
// error — they are looking at a capability that is not switched on here. Only
// a malformed request (400) or a genuinely failed embed (500) leaves the 2xx
// band. This is "derived data enriches, it never gates" spelled as a status
// code: no photo surface may show a failure because the index is cold.
//
// OWNER-ONLY, BY CONSTRUCTION. Like the import and blob routes, this handler
// works through `plane.ownerCredential` and nothing else — there is no app or
// device credential path into it, and the constrained-Companion allowlist
// (`serve/companion-access.ts`) does not name this path, so a paired companion
// device cannot reach it. Semantic search reads across the whole library at
// once; that is an owner capability, not an app-grantable scope.
//
// MOUNTING. `/centraid/_vault/enrich/semantic-search` is DEEPER than the
// owner's enrichment-settings surface at `/centraid/_vault/enrich` and than
// the generic `_vault` handler, and `createRoutePrefixDispatch` runs the most
// specific match first — so this route is reached before either, and the
// settings surface keeps its own path untouched.

import type { IncomingMessage, ServerResponse } from "node:http";

import { resolveEmbedder } from "../enrich/embedder.js";
import type { Embedder } from "../enrich/embedder.js";
import { searchPhotosByText } from "../enrich/semantic-search.js";
import type { RouteHandler } from "../serve/build-gateway.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import { readJson, sendError, sendJson } from "./route-helpers.js";

export const SEMANTIC_SEARCH_PATH = "/centraid/_vault/enrich/semantic-search";

/** A query is a phrase, not a document — an embedder's text window is small. */
const MAX_QUERY_CHARS = 512;

export interface EnrichSearchRouteOptions {
  /**
   * The host's embedder. Resolved from the environment when omitted; passed
   * explicitly by tests and by hosts that wire their own. `null` is a valid
   * value meaning "this host has none", which the route answers honestly.
   */
  embedder?: Embedder | null;
}

export function makeEnrichSearchRouteHandler(
  vaults: Pick<VaultRegistry, "current">,
  options: EnrichSearchRouteOptions = {}
): RouteHandler {
  // Resolved ONCE at wiring time: the embedder is host configuration, not
  // per-request state, and re-reading process.env per request would let a
  // half-configured restart serve two different answers.
  const embedder =
    options.embedder === undefined ? resolveEmbedder() : options.embedder;
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
        embedder,
        query,
        ...(typeof body.limit === "number" ? { limit: body.limit } : {}),
      });
      return sendJson(res, 200, outcome);
    } catch (error) {
      // The one genuine failure: a configured embedder that ran and failed
      // (crashed, timed out, produced garbage). That is an operator fault the
      // surface must be able to report, so it does NOT masquerade as
      // `unavailable` — a member who set this up deserves to know it broke.
      return sendError(res, error);
    }
  };
}
