// Semantic photo search (issue #721 E3): the query half of the embedding
// index. A phrase becomes a vector through the SAME embed-text automation that
// wrote the rows, and the vector is ranked against `enrich_embedding` by cosine.
//
// TWO CAPABILITIES, ONE SPACE (issue #724 W1). The rows are keyed by the
// `embed-image` model, because that is what produced them; the query rides
// `embed-text`. The two bundled handlers must share a model/vector space — a
// text query is compared to image vectors by cosine, so mismatched models
// return confident nonsense. The common pinned model id is that contract.
//
// TWO ENGINES, ONE ANSWER. When the host loaded `sqlite-vec` into this vault
// handle, ranking is `vec_distance_cosine` inside SQLite, which filters trashed
// assets and applies the LIMIT in the same statement. When it did not — an
// unsupported platform, a missing optional dependency — ranking is
// `scanEmbeddings`, the exact float32 cosine scan `@centraid/vault` has always
// carried. They are the same function: sqlite-vec's cosine DISTANCE is
// `1 - similarity`, so `score = 1 - distance` reproduces `cosine()` to float
// rounding, and both orderings match. That parity is what makes the extension
// an optimization rather than a feature — the search surface behaves
// identically either way, which is the only honest way to ship a native
// dependency that four of five platforms have and the fifth does not.
//
// NO VIRTUAL TABLE. sqlite-vec also offers `vec0` shadow tables with real ANN
// indexes; this uses only its scalar distance function over the EXISTING
// `enrich_embedding.vector` BLOB. That keeps the extension strictly additive:
// no schema rung, no second copy of every vector to keep in sync, and a vault
// opened on a platform without the extension is not missing a table — it is
// just using the other ranker. Revisit when a personal library's linear scan
// stops being fast; the row shape needs no change to get there.
//
// COST. The fallback ranker reads every embedding row for the model — that is
// what an exact scan is. It is bounded in the only place this module can bound
// it: `FALLBACK_CANDIDATES` caps how many top matches are carried forward to
// the liveness filter. The vec path has no such ceiling because SQLite does
// the filtering and the LIMIT itself.

import { scanEmbeddings } from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import { hasSqliteVec } from "./sqlite-vec.js";

const TARGET_TYPE = "media.asset";

/** Default hits returned when the caller names no limit. */
export const DEFAULT_SEARCH_LIMIT = 20;
/** Hard ceiling on `limit`, so one request cannot ask for the library. */
export const MAX_SEARCH_LIMIT = 100;
/**
 * Top matches the fallback ranker carries into the liveness filter. A stated
 * bound rather than an assumption that trash is rare: a library where more
 * than this many BETTER-scoring assets sit in the trash returns fewer hits on
 * the fallback path than on the vec path. Trashed assets keep their embeddings
 * only until their grace window lapses (`cleanupPolyRefs` drops them at
 * purge), so the window in which the two paths could disagree is bounded too.
 */
export const FALLBACK_CANDIDATES = 500;

/** One match, in the wire shape the search route returns verbatim. */
export interface PhotoSearchHit {
  assetId: string;
  contentId: string;
  /** Cosine similarity in [-1, 1]; higher is closer. */
  score: number;
}

export type PhotoSearchOutcome =
  | { status: "ok"; model: string; hits: PhotoSearchHit[] }
  | { status: "unavailable"; reason: string };

export interface PhotoSearchOptions {
  /** Invoke and await the release-managed embed-text automation. */
  embedQuery: (
    query: string
  ) => Promise<
    | { status: "ok"; model: string; vector: number[] }
    | { status: "unavailable"; reason: string }
  >;
  query: string;
  limit?: number;
}

/**
 * Rank live photographs against a text query.
 *
 * `unavailable` is a 200-level ANSWER, not an error: the bundled automation is
 * disabled, its local model assets are absent, or nothing is indexed for its
 * model yet. All are ordinary states of a gateway whose owner has not opted
 * into enrichment, and a surface must be able to say "not available here"
 * without rendering a failure. Derived data enriches, it never gates.
 *
 * An automation that RAN and failed is the one genuine failure and it THROWS,
 * so the route can answer 500: an owner who enabled it deserves to know it
 * broke rather than to be told it was never switched on.
 */
export async function searchPhotosByText(
  db: VaultDb,
  options: PhotoSearchOptions
): Promise<PhotoSearchOutcome> {
  const embedded = await options.embedQuery(options.query);
  if (embedded.status === "unavailable") return embedded;
  const indexed = db.vault
    .prepare(
      "SELECT count(*) AS n FROM enrich_embedding WHERE target_type = ? AND model = ?"
    )
    .get(TARGET_TYPE, embedded.model) as { n: number };
  if (indexed.n === 0) {
    return {
      status: "unavailable",
      reason: `no photos are indexed for ${embedded.model} yet — the embed-image automation indexes them in the background`,
    };
  }
  const limit = Math.min(
    Math.max(1, Math.trunc(options.limit ?? DEFAULT_SEARCH_LIMIT)),
    MAX_SEARCH_LIMIT
  );
  const hits = hasSqliteVec(db.vault)
    ? rankWithVec(db, embedded.model, embedded.vector, limit)
    : rankWithScan(db, embedded.model, embedded.vector, limit);
  return { status: "ok", model: embedded.model, hits };
}

function rankWithVec(
  db: VaultDb,
  model: string,
  vector: readonly number[],
  limit: number
): PhotoSearchHit[] {
  const query = Buffer.allocUnsafe(vector.length * 4);
  vector.forEach((value, index) => {
    query.writeFloatLE(value, index * 4);
  });
  // `e.dim = ?` is load-bearing: `vec_distance_cosine` RAISES on mismatched
  // lengths, so a stale row from a model of another width would turn a search
  // into an error. The scan ranker scores such a row 0 and drops it; this
  // clause is how the vec path reaches the same outcome.
  const rows = db.vault
    .prepare(
      `SELECT e.target_id AS asset_id, a.content_id AS content_id,
              vec_distance_cosine(e.vector, ?) AS distance
         FROM enrich_embedding e
         JOIN media_asset a ON a.asset_id = e.target_id
        WHERE e.target_type = ? AND e.model = ? AND e.dim = ?
          AND a.deleted_at IS NULL
        ORDER BY distance
        LIMIT ?`
    )
    .all(query, TARGET_TYPE, model, vector.length, limit) as unknown as {
    asset_id: string;
    content_id: string;
    distance: number;
  }[];
  return rows.map((row) => ({
    assetId: row.asset_id,
    contentId: row.content_id,
    score: 1 - row.distance,
  }));
}

function rankWithScan(
  db: VaultDb,
  model: string,
  vector: readonly number[],
  limit: number
): PhotoSearchHit[] {
  const scanned = scanEmbeddings(db.vault, model, vector, {
    entityTypes: [TARGET_TYPE],
    limit: FALLBACK_CANDIDATES,
  });
  const liveContent = db.vault.prepare(
    "SELECT content_id FROM media_asset WHERE asset_id = ? AND deleted_at IS NULL"
  );
  const hits: PhotoSearchHit[] = [];
  for (const hit of scanned) {
    if (hits.length === limit) break;
    const row = liveContent.get(hit.entityId) as
      | { content_id: string }
      | undefined;
    if (!row) continue;
    hits.push({
      assetId: hit.entityId,
      contentId: row.content_id,
      score: hit.score,
    });
  }
  return hits;
}
