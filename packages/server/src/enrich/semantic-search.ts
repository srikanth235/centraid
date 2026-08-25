// Semantic photo search (#721): the query half of the embedding index.
//
// TWO CAPABILITIES, ONE SPACE (#724). Rows are keyed by `embed-image`, the
// query rides `embed-text`; both bundled handlers MUST pin the same model id
// or the cosine returns confident nonsense.
//
// TWO ENGINES, ONE ANSWER. `sqlite-vec`'s `vec_distance_cosine` and the
// `scanEmbeddings` fallback must stay the same function: distance is
// `1 - similarity`, so `score = 1 - distance`. The extension is an
// optimization, never a feature.
//
// NO VIRTUAL TABLE. Use only the scalar distance over the existing
// `enrich_embedding.vector` BLOB; a `vec0` shadow table adds a schema rung and
// a second copy of every vector. Revisit when linear scan stops being fast.
//
// COST. The fallback reads every embedding row for the model;
// `FALLBACK_CANDIDATES` is the only ceiling this module can impose.

import { scanEmbeddings } from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import { hasSqliteVec } from "./sqlite-vec.js";

const TARGET_TYPE = "media.asset";

export const DEFAULT_SEARCH_LIMIT = 20;
/** So one request cannot ask for the library. */
export const MAX_SEARCH_LIMIT = 100;
/**
 * A stated bound, not an assumption that trash is rare: past this many
 * better-scoring trashed assets the fallback returns fewer hits than the vec
 * path. Purge drops their embeddings, so the divergence window is bounded.
 */
export const FALLBACK_CANDIDATES = 500;

/** The wire shape the search route returns verbatim. */
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
 * `unavailable` is a 200-level ANSWER, never an error: enrichment off, model
 * assets absent, nothing indexed yet are all ordinary states, and derived data
 * must never gate a surface. Only an automation that RAN and failed throws, so
 * an owner who enabled it hears that it broke.
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
  // `e.dim = ?` is load-bearing: `vec_distance_cosine` RAISES on a mismatched
  // width, so a stale row would turn a search into an error. The scan ranker
  // scores such a row 0; this clause is how the vec path matches it.
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
