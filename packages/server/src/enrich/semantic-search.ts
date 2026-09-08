// Semantic photo search (#721): the query half of the embedding index.
//
// TWO CAPABILITIES, ONE SPACE (#724). Rows are keyed by `embed-image`, the
// query rides `embed-text`; both MUST pin the same model id or the cosine
// returns nonsense.
//
// TWO ENGINES, ONE ANSWER. Both rankers and the trashed-asset filter live in
// the vault (`rankLivePhotoEmbeddings`), where the SQL belongs; this file
// picks the engine and turns the phrase into a vector. The extension is an
// optimization, never a feature.
//
// NO VIRTUAL TABLE (#883 C2, ruling Q12): scalar distance over the existing
// `enrich_embedding.vector` BLOB only — `vec0` adds a schema rung and a second
// copy of every vector. That ruling is conditional and its condition is
// instrumented by `tests/scale/photo-similarity.scale.test.ts`: the day either
// engine misses `photoSemanticSearchAtYear3`, `vec0` has been earned.

import { countPhotoEmbeddings, rankLivePhotoEmbeddings } from "@centraid/vault";
import type { PhotoEmbeddingHit, VaultDb } from "@centraid/vault";

import { hasSqliteVec } from "./sqlite-vec.js";

export const DEFAULT_SEARCH_LIMIT = 20;
/** So one request cannot ask for it all. */
export const MAX_SEARCH_LIMIT = 100;
/**
 * Best-scoring embeddings carried past the trashed-asset filter. A stated
 * bound, not an assumption that trash is rare: past this many better-scoring
 * trashed assets a search returns fewer hits. BOTH engines use it (#883).
 */
export const RANKING_CANDIDATES = 500;

export type PhotoSearchHit = PhotoEmbeddingHit;

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
  if (countPhotoEmbeddings(db.vault, embedded.model) === 0) {
    return {
      status: "unavailable",
      reason: `no photos are indexed for ${embedded.model} yet — the embed-image automation indexes them in the background`,
    };
  }
  const limit = Math.min(
    Math.max(1, Math.trunc(options.limit ?? DEFAULT_SEARCH_LIMIT)),
    MAX_SEARCH_LIMIT
  );
  const hits = rankLivePhotoEmbeddings(db.vault, {
    model: embedded.model,
    vector: embedded.vector,
    engine: options.engine ?? (hasSqliteVec(db.vault) ? "vec" : "scan"),
    limit,
    candidates: RANKING_CANDIDATES,
  });
  return { status: "ok", model: embedded.model, hits };
}
