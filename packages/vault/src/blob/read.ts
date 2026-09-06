// Blob egress resolution (#296). Byte-read authorization is DERIVED, never
// granted: content serves iff some edge links it to a subject row, trashed
// edges included.

import type { DatabaseSync } from "node:sqlite";

import { contentReferenceExists } from "../schema/content-references.js";
import { contentMediaTypeSql } from "../schema/representation.js";
import {
  BINARY_DERIVATIVE_SQL,
  isBinaryDerivative,
  isDerivativeVariant,
} from "./derivatives.js";
import type { BinaryDerivativeVariant } from "./derivatives.js";
import { shaOfBlobUri } from "./store.js";

// A literal: blob/ stays free of command-layer imports.

/** The ONE content-reference list without its live-rows-only clamp: trash
 *  renders until it purges (#352). A superseded page serves while some live
 *  document's history NAMES it — one indexed lookup on
 *  `core_entity_revision.content_id` since #996 (R20(a)), where it used to be a
 *  recursive walk from the requested page toward newer `revises` edges. */
const SERVE_REFERENCES: string[] = [
  ...contentReferenceExists({
    idExpression: "i.content_id",
    live: false,
    includeDocumentHead: true,
  }),
  `SELECT 1 FROM core_entity_revision r
     JOIN core_document d ON d.document_id = r.entity_id
    WHERE r.entity_type = 'core.document' AND r.content_id = i.content_id
      AND d.deleted_at IS NULL`,
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
      `SELECT i.content_id, i.content_uri, i.byte_size,
              -- THE REPRESENTATION'S ANSWER (#996, ruling R20(b)): the door
              -- addresses bytes by content id with no owner in hand, so it
              -- serves the oldest owner's reading of them. A caller that
              -- knows its owner reads the type off that representation.
              ${contentMediaTypeSql("i.content_id")} AS media_type,
              -- The title is a WRAPPER's — bytes have no name of their own
              -- any more. A document's wins; else the owning asset's.
              COALESCE(
                (SELECT d.title FROM core_document d WHERE d.current_content_id = i.content_id LIMIT 1),
                (SELECT a.title FROM media_asset a WHERE a.content_id = i.content_id LIMIT 1)) AS title,
              (${SERVE_REFERENCES.map((q) => `EXISTS(${q})`).join(" + ")}) AS refs
         FROM core_content_item i WHERE i.content_id = ?`
    )
    .get(contentId) as
    | {
        content_id: string;
        content_uri: string;
        media_type: string | null;
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
      mediaType: row.media_type ?? "application/octet-stream",
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

const DERIVATIVE_IN_CHUNK = 500;

/** Many ids in one indexed sweep (#405). CALLERS filter to reachable ids
 *  first: this does not re-run serve-reachability. */
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
 *  this one's. */
function vaultWriteKey(vault: DatabaseSync): string {
  const dataVersion = (
    vault.prepare("PRAGMA data_version").get() as { data_version: number }
  ).data_version;
  const totalChanges = (
    vault.prepare("SELECT total_changes() AS n").get() as { n: number }
  ).n;
  return `${dataVersion}:${totalChanges}`;
}

/** Once per write position (#659). READ-ONLY: it is shared. */
export function liveBlobShasCached(vault: DatabaseSync): ReadonlySet<string> {
  const writeKey = vaultWriteKey(vault);
  const memo = liveShaMemo.get(vault);
  if (memo?.writeKey === writeKey) return memo.shas;
  const shas = liveBlobShas(vault);
  liveShaMemo.set(vault, { writeKey, shas });
  return shas;
}
