/**
 * THE WIRE BOUNDARY FOR "WHAT IS THIS?" (#996, ruling R20(b), drift ONT-28).
 *
 * `core.content_item` is bytes: it carries no `media_type` and no `title`.
 * What the bytes ARE is `core.content_representation`, one row per
 * `(owner_type, owner_id)` — so the same sha is text/html under one document
 * and text/plain under another. App rows still ship a `media_type` FIELD,
 * because a Docs row on a phone has to say what it is; this is the one place
 * that field is filled in, and every app query fills it here.
 *
 * One read, two indexes. `byOwner` is the right answer wherever the caller
 * knows the owner (a document, a note, an asset, an attachment); `byContent`
 * is the fallback for a surface addressing bytes with no owner in hand, and
 * takes the oldest reading of them.
 */

import { inList, readPages } from "./paged-reads.ts";

/**
 * The PHYSICAL table, because a page is plain SQL over the seat's own copy of
 * `vault.db` and over the gateway's file (W4-D2) — the same statement on both,
 * with the entity recovered from `<schema>_<table>` for the scope check.
 */
const REPRESENTATION_TABLE = "core_content_representation";

interface RawRepresentation {
  representation_id: string;
  content_id: string;
  owner_type?: string | null;
  owner_id?: string | null;
  media_type?: string | null;
  created_at?: string | null;
}

export interface RepresentationIndex {
  /** `${owner_type}\0${owner_id}` → media type. */
  byOwner: Map<string, string>;
  /** content id → the oldest owner's media type. */
  byContent: Map<string, string>;
}

export function ownerKey(ownerType: string, ownerId: string): string {
  return `${ownerType}\0${ownerId}`;
}

export const EMPTY_REPRESENTATIONS: RepresentationIndex = {
  byOwner: new Map(),
  byContent: new Map(),
};

/**
 * Representations of a bounded set of content ids. A consent denial is not an
 * error here: the caller renders without a type rather than failing the
 * screen, exactly as it already does for a content item it may not read.
 */
export async function readRepresentations(args: {
  ctx: HandlerCtx;
  contentIds: readonly string[];
}): Promise<RepresentationIndex> {
  if (args.contentIds.length === 0) return EMPTY_REPRESENTATIONS;
  // A join over a set the CALLER already bounded — the content ids of the rows
  // its own window returned — so it is walked to the end rather than windowed
  // again. `representation_id` is the keyset's second axis because
  // `content_id` is not unique here: one sha read as two things by two owners
  // is exactly the row this table exists for.
  const ids = inList("content_id", args.contentIds);
  let rows: RawRepresentation[];
  try {
    rows = await readPages<RawRepresentation>(args.ctx, {
      name: "_shared/representations",
      select:
        "representation_id, content_id, owner_type, owner_id, media_type, created_at",
      from: REPRESENTATION_TABLE,
      where: ids.sql,
      bind: ids.bind,
      order: {
        sortColumn: "created_at",
        pkColumn: "representation_id",
        descending: false,
      },
    });
  } catch {
    return EMPTY_REPRESENTATIONS;
  }
  const byOwner = new Map<string, string>();
  const byContent = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.media_type !== "string" || row.media_type.length === 0)
      continue;
    if (typeof row.owner_type === "string" && typeof row.owner_id === "string")
      byOwner.set(ownerKey(row.owner_type, row.owner_id), row.media_type);
    // First wins: the read is ordered oldest-first, so this is the same
    // deterministic answer the vault's own content-keyed resolver gives.
    if (!byContent.has(row.content_id))
      byContent.set(row.content_id, row.media_type);
  }
  return { byOwner, byContent };
}
