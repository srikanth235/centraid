import type { DatabaseSync } from "node:sqlite";

import { encodeVector } from "../enrich/similarity.js";

interface EmbeddingPayload {
  model: string;
  vector: number[];
}

export function upsertContentEmbedding(
  vault: DatabaseSync,
  input: {
    contentId: string;
    canonicalPayload: string;
    embeddingId: string;
    createdAt: string;
  }
): void {
  const payload = JSON.parse(input.canonicalPayload) as EmbeddingPayload;
  vault
    .prepare(
      `DELETE FROM enrich_embedding
        WHERE target_type = 'core.content_item' AND target_id = ? AND model <> ?`
    )
    .run(input.contentId, payload.model);
  vault
    .prepare(
      `INSERT INTO enrich_embedding
         (embedding_id, target_type, target_id, model, dim, vector, created_at)
       VALUES (?, 'core.content_item', ?, ?, ?, ?, ?)
       ON CONFLICT (target_type, target_id, model) DO UPDATE SET
         dim = excluded.dim, vector = excluded.vector,
         created_at = excluded.created_at`
    )
    .run(
      input.embeddingId,
      input.contentId,
      payload.model,
      payload.vector.length,
      encodeVector(payload.vector),
      input.createdAt
    );
}
