// THE CORE SPINE'S 1:1 SIDE TABLES.
//
// Both of these hang off a `core` row one-for-one and were split out of
// `core.ts` when it outgrew the repo's file-size limit. They are here together
// because they are the same KIND of thing — a table that exists so a wide or
// optional value does not sit on a hot spine row — and nothing else about
// them is shared. The spine itself is `core.ts`; `migrate.ts` applies all
// three in order.

import {
  ROW_VERSION_COLUMN,
  UPDATED_AT_DEFAULT,
  touchUpdatedAt,
} from "./updated-at.js";

// Standoff anchor for inline references (#282). An anchor is a LOCATOR
// for an existing core.link judgment, not a second judgment (rule 10): it
// points into the from-endpoint's plain body text with a W3C-style selector
// {exact, prefix, suffix, start} so the read view can render the edge as an
// inline chip. Bodies stay canonical deduped bytes — the anchor lives outside
// them. One anchor per link (an inline mention IS one edge); no independent
// lifecycle: resolution only considers live links, so anchors of ended links
// are simply never resolved, and the dangling-link sweep needs no extension.
export const LINK_ANCHOR_DDL = `
CREATE TABLE core_link_anchor (
  anchor_id     TEXT PRIMARY KEY,
  link_id       TEXT NOT NULL UNIQUE REFERENCES core_link(link_id),
  selector_json TEXT NOT NULL CHECK (json_valid(selector_json)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  ${ROW_VERSION_COLUMN},
  FOREIGN KEY (anchor_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
${touchUpdatedAt("core_link_anchor", "anchor_id")}
`;

/**
 * `core_content_text` — DECODED BODY TEXT AS A COLUMN (#996, rulings R4 / R8).
 *
 * The FTS sync triggers used to decode a body by calling an
 * APPLICATION-DEFINED SQL function that only `openVaultDb` registered — which
 * is exactly why "only the gateway holds connections" was true, and why the
 * search index could not follow the vault onto a seat: expo-sqlite exposes no
 * way to register a SQL function, and a trigger has to index a COLUMN. The
 * decode moved to write time (`schema/representation.ts`), the triggers read
 * this column, and the same trigger text now runs on every seat.
 *
 * A 1:1 side table, not a column on `core_content_item` (R8): a decoded body is
 * the widest value in the model, and a wide column on a hot table makes every
 * `SELECT *` over it pay for text nobody asked for.
 *
 * `ON DELETE CASCADE` because this is DERIVED, REBUILDABLE data owned by the
 * content row — the "owned child" deletion role (R22): it has no meaning, and
 * no life, apart from the bytes it decodes.
 */
export const CONTENT_TEXT_DDL = `
CREATE TABLE core_content_text (
  content_id  TEXT PRIMARY KEY
    REFERENCES core_content_item(content_id) ON DELETE CASCADE,
  -- The decoded text itself. NOT NULL: a row exists because a decode
  -- SUCCEEDED, and "we could not decode these bytes" is the ABSENCE of a row,
  -- never an empty string that reads as an empty document.
  body_text   TEXT NOT NULL,
  -- What produced it, so a decoder change can rebuild exactly the rows it
  -- invalidates rather than the whole table.
  decoder     TEXT NOT NULL,
  -- The bytes this text was decoded FROM. Content is hash-addressed and
  -- immutable, so this is a staleness check against the decoder, not the row.
  byte_size   INTEGER NOT NULL CHECK (byte_size >= 0),
  created_at  TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  updated_at  TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  ${ROW_VERSION_COLUMN}
) STRICT;
${touchUpdatedAt("core_content_text", "content_id")}
`;
