// The data_uri compatibility door (issue #296 §3): commands still accept a
// small inline payload — one call, no fetch orchestration — but the ROW
// never swallows binary bytes again. Text stays inline (the FTS triggers
// decode it in-transaction); anything else spills synchronously into the
// local CAS and the row keeps only `blob:sha256-<hex>`. Identity is the
// sha256 of the RAW DECODED bytes for both classes — never the data: URI —
// which is also what fixes the old dedup hole (same bytes, different
// declared mime type, two rows).

import type { HandlerCtx } from '../gateway/types.js';
import { sha256OfBytes, blobUriFor } from './store.js';

/**
 * Decoded-size cap for the inline door: ~256 KB of content, ~350 KB of
 * base64. Anything larger takes the staging route (POST /_vault/blobs).
 * The old 8 MB `MAX_DATA_URI_CHARS` rows are gone with this — a vault WITH
 * a blob store refuses to swallow big payloads through command JSON, because
 * the journal records every input.
 */
export const MAX_INLINE_DATA_URI_CHARS = 360_000;

export interface DecodedDataUri {
  mediaType: string;
  bytes: Buffer;
}

/** Parse and DECODE a data: URI — the bytes are identity now, not the text. */
export function decodeDataUri(uri: string): DecodedDataUri {
  if (!uri.startsWith('data:')) throw new Error('payload must be a data: URI');
  const comma = uri.indexOf(',');
  if (comma === -1) throw new Error('malformed data: URI (no comma)');
  const meta = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  const isBase64 = meta.split(';').includes('base64');
  const mediaType = meta.split(';')[0] || 'application/octet-stream';
  const bytes = isBase64
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');
  return { mediaType, bytes };
}

export interface MintedContent {
  contentId: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  deduped: 0 | 1;
}

/**
 * Dedupe-or-insert the canonical content item behind an inline payload.
 * Re-presenting known bytes restores them from trash (re-upload = restore,
 * media.add_asset's rule) and optionally retitles.
 */
export function mintContentFromDataUri(
  ctx: HandlerCtx,
  uri: string,
  options: { title?: string } = {},
): MintedContent {
  const { mediaType, bytes } = decodeDataUri(uri);
  const sha = sha256OfBytes(bytes);
  const existing = ctx.db
    .prepare('SELECT content_id, media_type, deleted_at FROM core_content_item WHERE sha256 = ?')
    .get(sha) as { content_id: string; media_type: string; deleted_at: string | null } | undefined;
  if (existing) {
    if (existing.deleted_at !== null || options.title) {
      ctx.db
        .prepare(
          `UPDATE core_content_item SET deleted_at = NULL, purge_at = NULL,
                  title = COALESCE(?, title) WHERE content_id = ?`,
        )
        .run(options.title ?? null, existing.content_id);
      ctx.wrote('core.content_item', existing.content_id);
    }
    return {
      contentId: existing.content_id,
      mediaType: existing.media_type,
      byteSize: bytes.length,
      sha256: sha,
      deduped: 1,
    };
  }
  // Text stays in the row (the FTS feed); binary bytes spill to the CAS.
  let contentUri: string;
  if (mediaType.startsWith('text/')) {
    contentUri = uri;
  } else {
    const spilled = ctx.blobs.spill(bytes);
    if (spilled !== sha) throw new Error('spill produced a different sha — refusing to mint');
    contentUri = blobUriFor(sha);
  }
  const contentId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, title, language, creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?)`,
    )
    .run(
      contentId,
      mediaType,
      contentUri,
      sha,
      bytes.length,
      options.title ?? null,
      ctx.identity.partyId,
      ctx.now,
    );
  ctx.wrote('core.content_item', contentId);
  return { contentId, mediaType, byteSize: bytes.length, sha256: sha, deduped: 0 };
}
