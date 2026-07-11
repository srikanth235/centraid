// Blob egress resolution (issue #296 §5). Deduped content is polymorphically
// shared — the same bytes can back a note attachment, a photo and an invoice
// — so byte-read authorization is DERIVED, never granted: content X serves
// iff some edge in the reference registry links X to a subject row, i.e. the
// owner put these bytes somewhere in their model (issue #272's
// both-endpoints rule extended to content items). Trashed edges still count
// (the Photos/Docs trash views render what they hold until the purge sweep
// actually reclaims the bytes); a fully unreferenced-but-unpurged item is in
// its grace window and still serves. What never serves: a sha nothing
// claims, and variants of an unservable parent.

import type { DatabaseSync } from 'node:sqlite';
import { shaOfBlobUri } from './store.js';

// Mirrors commands/links.ts RELATIONS_SCHEME_URI (imported by literal to
// keep blob/ free of command-layer imports; the scheme URI is contract).
const RELATIONS_SCHEME_URI = 'urn:duaility:relations';

/**
 * Byte-renting edges, the serve-side twin of media.ts CONTENT_REFERENCES —
 * deliberately WITHOUT the live-rows-only clamp (trash must render). A
 * document's CURRENT content is a direct edge (core_document.current_content
 * _id); a SUPERSEDED revision serves through the `revises` chain instead —
 * version history must render just as readily as the current page (issue
 * #352). Both fold in regardless of the document's own trash state, matching
 * the old folder-tag behaviour that survived trash (the tag was never
 * removed) and never fully removed either (trash renders until purge).
 */
const SERVE_REFERENCES: string[] = [
  'SELECT 1 FROM core_attachment WHERE content_id = i.content_id',
  'SELECT 1 FROM core_party WHERE avatar_content_id = i.content_id',
  'SELECT 1 FROM knowledge_note WHERE body_content_id = i.content_id',
  'SELECT 1 FROM social_message WHERE body_content_id = i.content_id',
  'SELECT 1 FROM business_invoice WHERE pdf_content_id = i.content_id',
  'SELECT 1 FROM home_warranty WHERE terms_content_id = i.content_id',
  'SELECT 1 FROM home_maintenance_plan WHERE instructions_content_id = i.content_id',
  'SELECT 1 FROM media_media_asset WHERE content_id = i.content_id',
  'SELECT 1 FROM core_collection WHERE cover_content_id = i.content_id',
  'SELECT 1 FROM core_document WHERE current_content_id = i.content_id',
  `WITH RECURSIVE chain(content_id) AS (
     SELECT current_content_id FROM core_document
     UNION
     SELECT l.to_id FROM core_link l JOIN chain ON l.from_id = chain.content_id
      WHERE l.from_type = 'core.content_item' AND l.to_type = 'core.content_item' AND l.valid_to IS NULL
        AND l.relation_concept_id = (SELECT c.concept_id FROM core_concept c
             JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
            WHERE s.uri = '${RELATIONS_SCHEME_URI}' AND c.notation = 'revises')
   )
   SELECT 1 FROM chain WHERE chain.content_id = i.content_id`,
];

export interface ServableBlob {
  contentId: string;
  sha256: string;
  mediaType: string;
  byteSize: number;
  title: string | null;
  /** Which variant resolved — `original` when no variant was asked. */
  variant: 'original' | 'thumb' | 'preview';
}

export type BlobResolveOutcome =
  | { status: 'ok'; blob: ServableBlob }
  | { status: 'not-found' }
  | { status: 'not-blob' } // inline text/* content has no byte endpoint
  | { status: 'unreferenced' } // exists but nothing in the model claims it
  | { status: 'no-variant' }; // parent serves, asked variant doesn't exist

/**
 * Resolve one content id (and optional variant) to servable bytes metadata.
 * The reachability derivation runs here so every transport (HTTP route,
 * future tunnel surface) inherits the same rule.
 */
export function resolveServableBlob(
  vault: DatabaseSync,
  contentId: string,
  variant?: string,
): BlobResolveOutcome {
  const row = vault
    .prepare(
      `SELECT i.content_id, i.content_uri, i.media_type, i.byte_size,
              -- A document's title outranks the bare content item's — the
              -- wrapper is what the owner renamed, current or superseded.
              COALESCE(
                (SELECT d.title FROM core_document d WHERE d.current_content_id = i.content_id LIMIT 1),
                i.title) AS title,
              (${SERVE_REFERENCES.map((q) => `EXISTS(${q})`).join(' + ')}) AS refs
         FROM core_content_item i WHERE i.content_id = ?`,
    )
    .get(contentId) as
    | {
        content_id: string;
        content_uri: string;
        media_type: string;
        byte_size: number;
        title: string | null;
        refs: number;
      }
    | undefined;
  if (!row) return { status: 'not-found' };
  if (row.refs === 0) return { status: 'unreferenced' };

  if (variant === 'thumb' || variant === 'preview') {
    const v = vault
      .prepare(
        `SELECT sha256, media_type, byte_size FROM core_content_derivative
          WHERE content_id = ? AND variant = ? AND sha256 IS NOT NULL`,
      )
      .get(contentId, variant) as
      | { sha256: string; media_type: string; byte_size: number }
      | undefined;
    if (!v) return { status: 'no-variant' };
    return {
      status: 'ok',
      blob: {
        contentId,
        sha256: v.sha256,
        mediaType: v.media_type,
        byteSize: v.byte_size,
        title: row.title,
        variant,
      },
    };
  }

  const sha = shaOfBlobUri(row.content_uri);
  if (!sha) return { status: 'not-blob' };
  return {
    status: 'ok',
    blob: {
      contentId,
      sha256: sha,
      mediaType: row.media_type,
      byteSize: row.byte_size,
      title: row.title,
      variant: 'original',
    },
  };
}

/**
 * Every sha the model still claims — original blobs, binary variants, staged
 * bytes (their TTL is their claim). This is the live set reconciliation
 * diffs the remote tier against, and what a purge sweep must NOT delete.
 */
export function liveBlobShas(vault: DatabaseSync): Set<string> {
  const live = new Set<string>();
  const uris = vault
    .prepare(`SELECT content_uri FROM core_content_item WHERE content_uri LIKE 'blob:%'`)
    .all() as { content_uri: string }[];
  for (const r of uris) {
    const sha = shaOfBlobUri(r.content_uri);
    if (sha) live.add(sha);
  }
  const variants = vault
    .prepare('SELECT sha256 FROM core_content_derivative WHERE sha256 IS NOT NULL')
    .all() as { sha256: string }[];
  for (const r of variants) live.add(r.sha256);
  const staged = vault.prepare('SELECT sha256 FROM blob_staging').all() as { sha256: string }[];
  for (const r of staged) live.add(r.sha256);
  return live;
}
