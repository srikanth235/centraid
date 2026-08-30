// Semantic photo search (#721): the query half of the embedding index.
//
// TWO CAPABILITIES, ONE SPACE (#724). Rows are keyed by `embed-image`, the
// query rides `embed-text`; both MUST pin the same model id or the cosine
// returns nonsense.
//
// TWO ENGINES, ONE ANSWER. `sqlite-vec`'s `vec_distance_cosine` and the
// `scanEmbeddings` fallback must stay one function: distance is
// `1 - similarity`. The extension is an optimization, never a feature.
//
// NO VIRTUAL TABLE (#883 C2, ruling Q12): scalar distance over the existing
// `enrich_embedding.vector` BLOB only — `vec0` adds a schema rung and a second
// copy of every vector. That ruling is conditional and its condition is
// instrumented by `tests/scale/photo-similarity.scale.test.ts`: the day either
// engine misses `photoSemanticSearchAtYear3`, `vec0` has been earned.

import { scanEmbeddings } from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import { hasSqliteVec } from "./sqlite-vec.js";

const TARGET_TYPE = "media.asset";

export const DEFAULT_SEARCH_LIMIT = 20;
/** So one request cannot ask for it all. */
export const MAX_SEARCH_LIMIT = 100;
/**
 * Best-scoring embeddings carried past the trashed-asset filter. A stated
 * bound, not an assumption that trash is rare: past this many better-scoring
 * trashed assets a search returns fewer hits. BOTH engines use it (#883).
 */
export const RANKING_CANDIDATES = 500;

export interface PhotoSearchHit {
  assetId: string;
  contentId: string;
  /** Cosine similarity in [-1, 1]; higher is closer. */
  score: number;
}

export type PhotoSearchOutcome =
  | { status: "ok"; model: string; hits: PhotoSearchHit[] }
  | { status: "unavailable"; reason: string };

/**
 * Absent means "the best this handle has", which every product call passes.
 * Naming one lets the rig check "two engines, one answer" on one handle, not
 * only on a host lacking the extension.
 */
export type PhotoSearchEngine = "vec" | "scan";

export interface PhotoSearchOptions {
  embedQuery: (
    query: string
  ) => Promise<
    | { status: "ok"; model: string; vector: number[] }
    | { status: "unavailable"; reason: string }
  >;
  query: string;
  limit?: number;
  engine?: PhotoSearchEngine;
}

/**
 * `unavailable` is a 200-level ANSWER, never an error: enrichment off, model
 * assets absent and nothing indexed are ordinary states, and derived data must
 * not gate a surface.
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
  const engine = options.engine ?? (hasSqliteVec(db.vault) ? "vec" : "scan");
  const hits =
    engine === "vec"
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
  // width, turning a search into an error; the scan ranker scores it 0.
  //
  // Two stages: rank over `enrich_embedding` ALONE, join `media_asset` only
  // for the candidate window (#883 C2) — one stage probes the asset index per
  // embedding to judge rows never returned.
  const rows = db.vault
    .prepare(
      `WITH candidate AS (
         SELECT target_id, vec_distance_cosine(vector, ?) AS distance
           FROM enrich_embedding
          WHERE target_type = ? AND model = ? AND dim = ?
          ORDER BY distance
          LIMIT ?
       )
       SELECT c.target_id AS asset_id, a.content_id AS content_id, c.distance
         FROM candidate c
         JOIN media_asset a ON a.asset_id = c.target_id
        WHERE a.deleted_at IS NULL
        ORDER BY c.distance
        LIMIT ?`
    )
    .all(
      query,
      TARGET_TYPE,
      model,
      vector.length,
      RANKING_CANDIDATES,
      limit
    ) as unknown as {
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
    limit: RANKING_CANDIDATES,
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
