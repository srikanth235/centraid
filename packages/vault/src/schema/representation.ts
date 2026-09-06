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
