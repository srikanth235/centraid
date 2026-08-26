// Blob egress resolution (#296). Byte-read authorization is DERIVED, never
// granted: content serves iff some edge links it to a subject row, and trashed
// edges still count (trash renders until purge).

import type { DatabaseSync } from "node:sqlite";

import {
  BINARY_DERIVATIVE_SQL,
  isBinaryDerivative,
  isDerivativeVariant,
} from "./derivatives.js";
import type { BinaryDerivativeVariant } from "./derivatives.js";
import { shaOfBlobUri } from "./store.js";

// A literal, not an import: blob/ stays free of command-layer imports.
const RELATIONS_SCHEME_URI = "urn:duaility:relations";

/** The serve-side twin of media.ts CONTENT_REFERENCES, without its
 *  live-rows-only clamp: trash must render (#352). */
const SERVE_REFERENCES: string[] = [
  "SELECT 1 FROM core_attachment WHERE content_id = i.content_id",
  "SELECT 1 FROM core_party WHERE avatar_content_id = i.content_id",
  "SELECT 1 FROM knowledge_note WHERE body_content_id = i.content_id",
  "SELECT 1 FROM social_message WHERE body_content_id = i.content_id",
  "SELECT 1 FROM business_invoice WHERE pdf_content_id = i.content_id",
  "SELECT 1 FROM home_warranty WHERE terms_content_id = i.content_id",
  "SELECT 1 FROM home_maintenance_plan WHERE instructions_content_id = i.content_id",
  "SELECT 1 FROM media_asset WHERE content_id = i.content_id",
  "SELECT 1 FROM core_collection WHERE cover_content_id = i.content_id",
  "SELECT 1 FROM core_document WHERE current_content_id = i.content_id",
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
  variant: "original" | BinaryDerivativeVariant;
}

export type BlobResolveOutcome =
  | { status: "ok"; blob: ServableBlob }
  | { status: "not-found" }
  | { status: "not-blob" } // inline text/* has no byte endpoint
  | { status: "unreferenced" } // exists, but nothing claims it
  | { status: "no-variant" }; // parent serves, the variant does not

export function resolveServableBlob(
  vault: DatabaseSync,
  contentId: string,
  variant?: string
): BlobResolveOutcome {
  const row = vault
    .prepare(
      `SELECT i.content_id, i.content_uri, i.media_type, i.byte_size,
              -- A document's title outranks the bare content item's — the
              -- wrapper is what the owner renamed, current or superseded.
              COALESCE(
                (SELECT d.title FROM core_document d WHERE d.current_content_id = i.content_id LIMIT 1),
                i.title) AS title,
              (${SERVE_REFERENCES.map((q) => `EXISTS(${q})`).join(" + ")}) AS refs
         FROM core_content_item i WHERE i.content_id = ?`
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
  if (!row) return { status: "not-found" };
  if (row.refs === 0) return { status: "unreferenced" };

  if (isDerivativeVariant(variant) && isBinaryDerivative(variant)) {
    const v = vault
      .prepare(
        `SELECT sha256, media_type, byte_size FROM core_content_derivative
          WHERE content_id = ? AND variant = ? AND sha256 IS NOT NULL`
      )
      .get(contentId, variant) as
      | { sha256: string; media_type: string; byte_size: number }
      | undefined;
    if (!v) return { status: "no-variant" };
    return {
      status: "ok",
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
  if (!sha) return { status: "not-blob" };
  return {
    status: "ok",
    blob: {
      contentId,
      sha256: sha,
      mediaType: row.media_type,
      byteSize: row.byte_size,
      title: row.title,
      variant: "original",
    },
  };
}

export interface DerivativeRef {
  sha256: string;
  mediaType: string;
  byteSize: number;
}

/** A bounded IN list keeps the plan stable across large id sets. */
const DERIVATIVE_IN_CHUNK = 500;

/** One rung for MANY ids in one indexed sweep (#405); ids with no such rung
 *  are absent. Does NOT re-run serve-reachability, so CALLERS must filter ids
 *  to reachable ones before batching. */
export function resolveDerivativeShas(
  vault: DatabaseSync,
  contentIds: readonly string[],
  variant: BinaryDerivativeVariant
): Map<string, DerivativeRef> {
  const out = new Map<string, DerivativeRef>();
  for (let i = 0; i < contentIds.length; i += DERIVATIVE_IN_CHUNK) {
    const chunk = contentIds.slice(i, i + DERIVATIVE_IN_CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = vault
      .prepare(
        `SELECT content_id, sha256, media_type, byte_size
           FROM core_content_derivative
          WHERE variant = ? AND sha256 IS NOT NULL
            AND content_id IN (${placeholders})`
      )
      .all(variant, ...chunk) as {
      content_id: string;
      sha256: string;
      media_type: string;
      byte_size: number;
    }[];
    for (const r of rows) {
      out.set(r.content_id, {
        sha256: r.sha256,
        mediaType: r.media_type,
        byteSize: r.byte_size,
      });
    }
  }
  return out;
}

export function liveBlobShas(vault: DatabaseSync): Set<string> {
  const live = new Set<string>();
  const uris = vault
    .prepare(
      `SELECT content_uri FROM core_content_item WHERE content_uri LIKE 'blob:%'`
    )
    .all() as { content_uri: string }[];
  for (const r of uris) {
    const sha = shaOfBlobUri(r.content_uri);
    if (sha) live.add(sha);
  }
  const variants = vault
    .prepare(
      "SELECT sha256 FROM core_content_derivative WHERE sha256 IS NOT NULL"
    )
    .all() as { sha256: string }[];
  for (const r of variants) live.add(r.sha256);
  const staged = vault
    .prepare(
      `SELECT sha256 FROM blob_staging
        WHERE variant IS NULL OR variant IN (${BINARY_DERIVATIVE_SQL})`
    )
    .all() as { sha256: string }[];
  for (const r of staged) live.add(r.sha256);
  return live;
}

interface LiveShaMemo {
  writeKey: string;
  shas: ReadonlySet<string>;
}

const liveShaMemo = new WeakMap<DatabaseSync, LiveShaMemo>();

/** `data_version` moves on another connection's commit, `total_changes` on
 *  this one's; together they cannot miss a mutation. */
function vaultWriteKey(vault: DatabaseSync): string {
  const dataVersion = (
    vault.prepare("PRAGMA data_version").get() as { data_version: number }
  ).data_version;
  const totalChanges = (
    vault.prepare("SELECT total_changes() AS n").get() as { n: number }
  ).n;
  return `${dataVersion}:${totalChanges}`;
}

/** Computed once per write position (#659). The set is READ-ONLY because it is
 *  shared — for a mutable copy, call `liveBlobShas`. */
export function liveBlobShasCached(vault: DatabaseSync): ReadonlySet<string> {
  const writeKey = vaultWriteKey(vault);
  const memo = liveShaMemo.get(vault);
  if (memo?.writeKey === writeKey) return memo.shas;
  const shas = liveBlobShas(vault);
  liveShaMemo.set(vault, { writeKey, shas });
  return shas;
}
