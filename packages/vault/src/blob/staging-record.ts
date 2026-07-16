// Register an already-hashed ingress result in the transient staging band.
// The buffered path (`staging.ts`) can inspect the complete body; resumable
// and direct-to-CAS paths intentionally cannot, so they provide metadata they
// learned while plaintext was flowing and converge here without re-reading a
// multi-hundred-megabyte object into RAM.

import type { DatabaseSync } from 'node:sqlite';
import { nowIso, uuidv7 } from '../ids.js';
import type { StagedBlob } from './staging.js';

export interface KnownStagedBlobInput {
  sha256: string;
  byteSize: number;
  mediaType?: string;
  filename?: string;
  stagedBy?: string;
  meta?: Record<string, unknown>;
}

export function recordKnownStagedBlob(
  vault: DatabaseSync,
  input: KnownStagedBlobInput,
): StagedBlob {
  const mediaType = input.mediaType ?? 'application/octet-stream';
  const meta = input.meta ?? {};
  const hasFreshMeta = input.meta !== undefined;
  const existing = vault
    .prepare('SELECT content_id FROM core_content_item WHERE sha256 = ?')
    .get(input.sha256) as { content_id: string } | undefined;
  vault
    .prepare(
      `INSERT INTO blob_staging
         (staging_id, sha256, media_type, byte_size, original_name, meta_json, staged_by,
          held_by_batch, variant, variant_of, staged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
       ON CONFLICT (sha256) WHERE variant IS NULL DO UPDATE SET
         media_type = excluded.media_type,
         byte_size = excluded.byte_size,
         original_name = COALESCE(excluded.original_name, blob_staging.original_name),
         meta_json = CASE WHEN ? = 1 THEN excluded.meta_json ELSE blob_staging.meta_json END,
         staged_by = excluded.staged_by,
         staged_at = excluded.staged_at`,
    )
    .run(
      uuidv7(),
      input.sha256,
      mediaType,
      input.byteSize,
      input.filename ?? null,
      JSON.stringify(meta),
      input.stagedBy ?? null,
      nowIso(),
      hasFreshMeta ? 1 : 0,
    );
  const effectiveMeta = JSON.parse(
    (
      vault
        .prepare('SELECT meta_json FROM blob_staging WHERE sha256 = ? AND variant IS NULL')
        .get(input.sha256) as { meta_json: string }
    ).meta_json,
  ) as Record<string, unknown>;
  return {
    sha256: input.sha256,
    mediaType,
    byteSize: input.byteSize,
    meta: effectiveMeta,
    existingContentId: existing?.content_id ?? null,
  };
}
