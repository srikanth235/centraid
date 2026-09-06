// THE ONE SPELLING OF "WHAT IS THIS?" (#996, ruling R20(b), drift ONT-28).
//
// `core_content_item` is bytes. What those bytes ARE is a property of the
// OWNER reading them, and it lives on `core_content_representation` — one row
// per (owner_type, owner_id). This module is the only place that knows the
// table's shape: every reader asks for a media type through `mediaTypeSql`
// (in SQL) or `mediaTypeOfOwner` / `mediaTypeForContent` (in TypeScript), and
// every writer goes through `setRepresentation`. One helper, so the split is
// one spelling and a later change is one edit — the reason the column could
// drift in the first place was that fifty-three sites each spelled it out.
//
// Wire types keep a `media_type` FIELD: a Docs row on the phone still says
// what it is. That field is POPULATED AT THE QUERY BOUNDARY from the
// representation row — it is a value in a projection, never a column on the
// byte row again.

import type { DatabaseSync } from "node:sqlite";

import { contentText } from "./content-text.js";

/**
 * What produced the text in `core_content_text`, so a decoder change can
 * rebuild exactly the rows it invalidates rather than the whole table.
 */
export const CONTENT_TEXT_DECODER = "data-uri/v1";

/** The owner half of a representation's key. */
export interface RepresentationOwner {
  /** Logical entity of the owner, e.g. `core.document`. */
  ownerType: string;
  ownerId: string;
}

export interface RepresentationInput extends RepresentationOwner {
  contentId: string;
  mediaType: string;
  charset?: string | null;
  interpretation?: string | null;
}

/**
 * Bytes that no wrapper claims yet — a connector's remote stub, a staged blob
 * an import has not filed. The content row owns its own reading until an owner
 * arrives, which is NOT the ONT-28 defect coming back: a later document, note
 * or asset gets its OWN row and reads the bytes its own way.
 */
export const UNCLAIMED_OWNER_TYPE = "core.content_item";

/**
 * SQL scalar subquery for one owner's media type. `ownerTypeExpr` and
 * `ownerIdExpr` are SQL expressions (a literal, a column, a bound `?`) —
 * inlined, so callers must never pass member input here.
 */
export function mediaTypeSql(
  ownerTypeExpr: string,
  ownerIdExpr: string
): string {
  return `(SELECT r.media_type FROM core_content_representation r
            WHERE r.owner_type = ${ownerTypeExpr} AND r.owner_id = ${ownerIdExpr})`;
}

/**
 * SQL scalar subquery for the media type of some content, with no owner in
 * hand — the read door addressing `/_vault/blobs/:content_id`, the enrichment
 * lease sweep, the custody passes.
 *
 * DETERMINISTIC, not arbitrary: the OLDEST representation wins (`created_at`,
 * then the id), so the answer does not depend on row order. Where two owners
 * disagree the caller that knows its owner must say so — that is what
 * `mediaTypeSql` is for, and every reader with an owner uses it.
 */
export function contentMediaTypeSql(contentIdExpr: string): string {
  return `(SELECT r.media_type FROM core_content_representation r
            WHERE r.content_id = ${contentIdExpr}
            ORDER BY r.created_at, r.representation_id LIMIT 1)`;
}

/** `mediaTypeSql`, evaluated. */
export function mediaTypeOfOwner(
  db: DatabaseSync,
  owner: RepresentationOwner
): string | null {
  const row = db
    .prepare(
      `SELECT media_type FROM core_content_representation
        WHERE owner_type = ? AND owner_id = ?`
    )
    .get(owner.ownerType, owner.ownerId) as { media_type: string } | undefined;
  return row?.media_type ?? null;
}

/** `contentMediaTypeSql`, evaluated. */
export function mediaTypeForContent(
  db: DatabaseSync,
  contentId: string
): string | null {
  const row = db
    .prepare(
      `SELECT media_type FROM core_content_representation
        WHERE content_id = ? ORDER BY created_at, representation_id LIMIT 1`
    )
    .get(contentId) as { media_type: string } | undefined;
  return row?.media_type ?? null;
}

/**
 * The ONE writer. Idempotent on `(owner_type, owner_id)`: an owner re-pointed
 * at other bytes, or re-typed, updates its row rather than growing a second
 * reading of itself.
 *
 * Returns the representation id, so a caller that must attach a derived row
 * (a generated caption, OQ-9) has the key it is meant to hang from.
 */
export function setRepresentation(
  db: DatabaseSync,
  newId: () => string,
  now: string,
  input: RepresentationInput
): string {
  // BEFORE the representation row, not after. The representation's own FTS
  // trigger is what puts the index back in step once the reading lands
  // (`schema/blob.ts`), and it reads `core_content_text` — so the text has to
  // be there when it fires.
  indexContentText(db, input.contentId, input.mediaType, now);
  const existing = db
    .prepare(
      `SELECT representation_id FROM core_content_representation
        WHERE owner_type = ? AND owner_id = ?`
    )
    .get(input.ownerType, input.ownerId) as
    | { representation_id: string }
    | undefined;
  if (existing) {
    db.prepare(
      `UPDATE core_content_representation
          SET content_id = ?, media_type = ?, charset = ?, interpretation = ?
        WHERE representation_id = ?`
    ).run(
      input.contentId,
      input.mediaType,
      input.charset ?? null,
      input.interpretation ?? null,
      existing.representation_id
    );
    return existing.representation_id;
  }
  const representationId = newId();
  db.prepare(
    `INSERT INTO core_content_representation
       (representation_id, content_id, owner_type, owner_id, media_type,
        charset, interpretation, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    representationId,
    input.contentId,
    input.ownerType,
    input.ownerId,
    input.mediaType,
    input.charset ?? null,
    input.interpretation ?? null,
    now
  );
  return representationId;
}

/**
 * DECODE AT WRITE TIME (#996, rulings R4 and R8) — the retirement of the
 * app-defined decode function.
 *
 * The FTS sync triggers used to decode a body by calling an
 * APPLICATION-DEFINED SQL function over the media type and the data: URI,
 * one only `openVaultDb` registered. That is exactly why "only the
 * gateway holds connections" had to be true, and why the search index could
 * not follow the vault onto a seat: expo-sqlite exposes no way to register a
 * SQL function, and a trigger has to index a COLUMN.
 *
 * So the decode moves HERE, to the one writer of a representation. This is
 * the right seam rather than a convenient one: a body's text is a function of
 * the bytes AND of what this owner says the bytes ARE (R20(b)), so it cannot
 * be derived from the content row alone and it changes exactly when the
 * representation changes. `content_uri` is hash-addressed and immutable, so
 * the row never goes stale except through a decoder change — which is what
 * `decoder` is for.
 *
 * ABSENCE IS THE ANSWER FOR "COULD NOT DECODE". `core_content_text.body_text`
 * is NOT NULL because a row exists when a decode SUCCEEDED; an empty string
 * would read as an empty document, which is a different and wrong claim.
 */
export function indexContentText(
  db: DatabaseSync,
  contentId: string,
  mediaType: string,
  now: string
): void {
  const row = db
    .prepare(`SELECT content_uri FROM core_content_item WHERE content_id = ?`)
    .get(contentId) as { content_uri: string } | undefined;
  const text = row ? contentText(mediaType, row.content_uri) : null;
  if (text === null) {
    // A representation re-typed from text to binary takes its text with it.
    db.prepare(`DELETE FROM core_content_text WHERE content_id = ?`).run(
      contentId
    );
    return;
  }
  db.prepare(
    `INSERT INTO core_content_text
       (content_id, body_text, decoder, byte_size, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (content_id) DO UPDATE SET
       body_text = excluded.body_text,
       decoder = excluded.decoder,
       byte_size = excluded.byte_size,
       updated_at = excluded.updated_at`
  ).run(
    contentId,
    text,
    CONTENT_TEXT_DECODER,
    Buffer.byteLength(text, "utf8"),
    now,
    now
  );
}

/** The representation id an owner reads its content through, if it has one. */
export function representationIdOf(
  db: DatabaseSync,
  owner: RepresentationOwner
): string | null {
  const row = db
    .prepare(
      `SELECT representation_id FROM core_content_representation
        WHERE owner_type = ? AND owner_id = ?`
    )
    .get(owner.ownerType, owner.ownerId) as
    | { representation_id: string }
    | undefined;
  return row?.representation_id ?? null;
}
