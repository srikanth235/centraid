// Staged-sha promotion (issue #296 §3): the moment bytes become model. Runs
// INSIDE a command's transaction — pure row work, no I/O (the bytes are
// already in the local CAS) — so the receipt the command mints is the
// receipt for custody. Shared by every claiming command (core.attach,
// core.add_document, media.add_asset) and by the import spine's publishers.

import type { DatabaseSync } from 'node:sqlite';
import type { BlobMeta } from './pipeline.js';
import { blobUriFor } from './store.js';

export interface PromoteDeps {
  vault: DatabaseSync;
  now: string;
  newId(): string;
  /** Provenance hook — ctx.wrote inside commands, a collector in publishers. */
  wrote(entityType: string, entityId: string): void;
  creatorPartyId: string | null;
}

export interface PromotedContent {
  contentId: string;
  mediaType: string;
  byteSize: number;
  meta: BlobMeta;
  /** 1 when the sha already had a live content item (restore/dedup). */
  deduped: 0 | 1;
}

/**
 * Claim one staged sha into a canonical content item. Idempotent over dedup:
 * when a content item already owns the sha, the claim restores it from trash
 * (re-upload = restore, the rule media.add_asset established) and just
 * consumes the staging rows. Staged derivatives riding beside the parent
 * (`variant_of = sha`) promote into `core_content_derivative`, and extracted
 * text becomes the `text` variant feeding the parent's FTS row.
 */
export function promoteStagedBlob(
  deps: PromoteDeps,
  sha256: string,
  options: { title?: string } = {},
): PromotedContent {
  const { vault } = deps;
  const staged = vault
    .prepare(
      'SELECT media_type, byte_size, original_name, meta_json FROM blob_staging WHERE sha256 = ? AND variant IS NULL',
    )
    .get(sha256) as
    | { media_type: string; byte_size: number; original_name: string | null; meta_json: string }
    | undefined;
  const existing = vault
    .prepare('SELECT content_id, media_type, byte_size, deleted_at FROM core_content_item WHERE sha256 = ?')
    .get(sha256) as
    | { content_id: string; media_type: string; byte_size: number; deleted_at: string | null }
    | undefined;
  if (!staged && !existing) {
    throw new Error(`no staged blob ${sha256} — upload it first (POST /_vault/blobs)`);
  }

  const meta: BlobMeta = staged ? (JSON.parse(staged.meta_json) as BlobMeta) : {};
  let contentId: string;
  let mediaType: string;
  let byteSize: number;
  let deduped: 0 | 1;
  if (existing) {
    contentId = existing.content_id;
    mediaType = existing.media_type;
    byteSize = existing.byte_size;
    deduped = 1;
    if (existing.deleted_at !== null) {
      vault
        .prepare(
          'UPDATE core_content_item SET deleted_at = NULL, purge_at = NULL WHERE content_id = ?',
        )
        .run(contentId);
      deps.wrote('core.content_item', contentId);
    }
    if (options.title) {
      vault
        .prepare('UPDATE core_content_item SET title = ? WHERE content_id = ?')
        .run(options.title, contentId);
    }
  } else {
    contentId = deps.newId();
    mediaType = staged!.media_type;
    byteSize = staged!.byte_size;
    deduped = 0;
    vault
      .prepare(
        `INSERT INTO core_content_item
           (content_id, media_type, content_uri, sha256, byte_size, title, language, creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?)`,
      )
      .run(
        contentId,
        mediaType,
        blobUriFor(sha256),
        sha256,
        byteSize,
        options.title ?? staged!.original_name ?? null,
        deps.creatorPartyId,
        deps.now,
      );
    deps.wrote('core.content_item', contentId);
  }

  promoteVariants(deps, sha256, contentId, meta);
  vault.prepare('DELETE FROM blob_staging WHERE sha256 = ?').run(sha256);
  return { contentId, mediaType, byteSize, meta, deduped };
}

/** Staged derivatives + extracted text → core_content_derivative rows. */
function promoteVariants(
  deps: PromoteDeps,
  parentSha: string,
  contentId: string,
  meta: BlobMeta,
): void {
  const { vault } = deps;
  const upsert = vault.prepare(
    `INSERT INTO core_content_derivative
       (derivative_id, content_id, variant, sha256, media_type, byte_size, text_content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (content_id, variant) DO UPDATE SET
       sha256 = excluded.sha256, media_type = excluded.media_type,
       byte_size = excluded.byte_size, text_content = excluded.text_content,
       created_at = excluded.created_at`,
  );
  const variants = vault
    .prepare(
      'SELECT sha256, media_type, byte_size, variant FROM blob_staging WHERE variant_of = ? AND variant IS NOT NULL',
    )
    .all(parentSha) as { sha256: string; media_type: string; byte_size: number; variant: string }[];
  for (const v of variants) {
    upsert.run(deps.newId(), contentId, v.variant, v.sha256, v.media_type, v.byte_size, null, deps.now);
    vault.prepare('DELETE FROM blob_staging WHERE sha256 = ?').run(v.sha256);
  }
  if (typeof meta.text === 'string' && meta.text.length > 0) {
    upsert.run(
      deps.newId(),
      contentId,
      'text',
      null,
      'text/plain',
      Buffer.byteLength(meta.text, 'utf8'),
      meta.text,
      deps.now,
    );
  }
}
