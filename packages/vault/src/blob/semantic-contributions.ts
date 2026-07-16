// Materialize inline contribution payloads into the established query
// sidecars. The derivative row is the typed/provenance-bearing source; these
// rows are the indexes existing search code already consumes.

import type { DatabaseSync } from 'node:sqlite';
import { encodeVector } from '../enrich/similarity.js';

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
  },
): void {
  const payload = JSON.parse(input.canonicalPayload) as EmbeddingPayload;
  // One typed `embedding` slot represents the current configured model. If
  // that model changes, leaving the previous vector searchable would make a
  // single contribution claim two incompatible vector spaces.
  vault
    .prepare(
      `DELETE FROM enrich_embedding
        WHERE entity_type = 'core.content_item' AND entity_id = ? AND model <> ?`,
    )
    .run(input.contentId, payload.model);
  vault
    .prepare(
      `INSERT INTO enrich_embedding
         (embedding_id, entity_type, entity_id, model, dim, vector, created_at)
       VALUES (?, 'core.content_item', ?, ?, ?, ?, ?)
       ON CONFLICT (entity_type, entity_id, model) DO UPDATE SET
         dim = excluded.dim, vector = excluded.vector,
         created_at = excluded.created_at`,
    )
    .run(
      input.embeddingId,
      input.contentId,
      payload.model,
      payload.vector.length,
      encodeVector(payload.vector),
      input.createdAt,
    );
}
