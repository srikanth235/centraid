// Photo semantic search (#721/#883), the vault half: the two rankers over
// `enrich_embedding` and the trashed-asset filter over `media_asset`. It lives
// here because raw SQL over a vault table belongs to the vault
// (`lint:vault-sql`); the server owns the query vector and the engine choice.

import type { DatabaseSync } from "node:sqlite";

import { rankEmbeddingsWithVec, scanEmbeddings } from "./similarity.js";
import type { SemanticHit } from "./similarity.js";

export const PHOTO_EMBEDDING_TARGET_TYPE = "media.asset";

export interface PhotoEmbeddingHit {
  assetId: string;
  contentId: string;
  /** Cosine similarity in [-1, 1]; higher is closer. */
  score: number;
}

/** Zero is an ordinary state — nothing is indexed for this model yet. */
export function countPhotoEmbeddings(
  vault: DatabaseSync,
  model: string
): number {
  const row = vault
    .prepare(
      "SELECT count(*) AS n FROM enrich_embedding WHERE target_type = ? AND model = ?"
    )
    .get(PHOTO_EMBEDDING_TARGET_TYPE, model) as { n: number };
  return row.n;
}

export interface PhotoRankOptions {
  model: string;
  vector: readonly number[];
  /** `vec` needs the `sqlite-vec` extension loaded; the caller checks. */
  engine: "vec" | "scan";
  limit: number;
  /**
   * Best-scoring embeddings carried past the trashed-asset filter. A stated
   * bound, not an assumption that trash is rare: past this many better-scoring
   * trashed assets a search returns fewer hits. BOTH engines use it (#883).
   */
  candidates: number;
}

/**
 * TWO ENGINES, ONE ANSWER: both rankers answer over `enrich_embedding` alone
 * and the same filter runs after, so a candidate window means the same thing
 * either way. Trashed rows are dropped here rather than joined away — one
 * stage probing `media_asset` per embedding judges rows never returned (#883).
 */
export function rankLivePhotoEmbeddings(
  vault: DatabaseSync,
  options: PhotoRankOptions
): PhotoEmbeddingHit[] {
  const ranked: SemanticHit[] =
    options.engine === "vec"
      ? rankEmbeddingsWithVec(vault, {
          model: options.model,
          vector: options.vector,
          entityTypes: [PHOTO_EMBEDDING_TARGET_TYPE],
          limit: options.candidates,
        })
      : scanEmbeddings(vault, options.model, options.vector, {
          entityTypes: [PHOTO_EMBEDDING_TARGET_TYPE],
          limit: options.candidates,
        });
  const liveContent = vault.prepare(
    "SELECT content_id FROM media_asset WHERE asset_id = ? AND deleted_at IS NULL"
  );
  const hits: PhotoEmbeddingHit[] = [];
  for (const hit of ranked) {
    if (hits.length === options.limit) break;
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
