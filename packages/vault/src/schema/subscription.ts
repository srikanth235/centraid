// A SHARE IS A SUBSCRIPTION (#929), AND THE GRANT IS THE SHAPE (#996, R10).
//
// Three tables. Two ride the canonical walk on the AUDIENCE seat — a restore
// without them hands back a vault that has forgotten which grants it holds
// rows for, so a later revoke would find nothing to purge and the copy would
// outlive the answer. The third is the ORIGIN's, and it is what makes sharing
// the same log under a closure predicate rather than a composed shape.
//
// KEYED BY `authority_id`, never by a shape id. `share_authority` IS the
// grant, and a grant-keyed `@share:<id>` sigil was a second name for the same
// row — one the origin had to mint, the audience had to store, and the peer
// route had to parse back into a grant before it could authorize anything.

import { UPDATED_AT_DEFAULT, touchUpdatedAt } from "./updated-at.js";

export const SHARE_SUBSCRIPTION_DDL = `
-- ONE ROW PER (grant, audience vault), on BOTH seats. The origin holds one per
-- audience it serves and reads \`cursor_seq\` as the audience's acknowledgement;
-- the audience holds exactly one — its own — and reads it as how far it has
-- ingested. Same question, two seats, one shape: a second table would let the
-- two answers drift, which is what makes a revoke settle early.
CREATE TABLE share_subscription (
  -- NO FOREIGN KEY to \`share_authority\`, deliberately: the AUDIENCE holds this
  -- row and never holds the origin's answer. Same reading as the member seat's
  -- intent overlay — a key here would make holding the subscription depend on
  -- holding the grant that authorizes it, which only the origin has.
  authority_id      TEXT NOT NULL,
  audience_vault_id TEXT NOT NULL,
  origin_vault_id   TEXT NOT NULL,
  -- Derivable from \`share_authority\` on the ORIGIN and only there: the
  -- audience never holds the grant, so its own row has to carry the subject.
  subject_type      TEXT NOT NULL,
  -- The origin's replica epoch this cursor is measured in. A changed epoch is
  -- a re-bootstrap, exactly as it is for a device (the phone's rule): the seat
  -- does not extend a floor on a subscriber's behalf.
  cursor_epoch      TEXT,
  cursor_seq        INTEGER NOT NULL DEFAULT 0 CHECK (cursor_seq >= 0),
  -- 'removed' is the audience's own acknowledgement that the grant's rows are
  -- gone. The origin's \`share_fulfillment\` vocabulary is untouched.
  state             TEXT NOT NULL CHECK (state IN ('subscribed','removed')),
  subscribed_at     TEXT NOT NULL,
  removed_at        TEXT,
  detail            TEXT,
  updated_at        TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  PRIMARY KEY (authority_id, audience_vault_id)
) STRICT;

-- GRANT-KEYED LINEAGE, the one answer to "which vault did this row come from".
-- A ROW-KEYED provenance table can name only ONE sender, so two grants over
-- the same photograph left the second invisible and revoking the first purged
-- a row the second still delivers. This table is the many-to-many the model
-- actually has: a row survives a purge while any other live grant claims it.
--
-- \`origin_row_version\` is the ORIGIN's current-epoch replica log sequence for
-- the row at ingest. It is what lets a member's phone drop a pending write
-- only once its replica holds the origin's answered version, so it travels
-- with the row rather than being re-derived from the audience's own log.
-- \`audience_row_version\` is THIS vault's \`row_version\` for the row as the
-- applier last wrote it. It is what makes local divergence detectable: a
-- projected row is read-only (#996, R10), so a claimed row whose version has
-- moved past this one was written by something on this side, and the origin's
-- copy is the answer. Without it the predicate transport would never re-send
-- an unchanged origin row and a tampered copy would survive every pass —
-- exactly the divergence the shape composer erased by re-reading everything.
CREATE TABLE share_subscription_lineage (
  authority_id       TEXT NOT NULL,
  target_type        TEXT NOT NULL,
  target_id          TEXT NOT NULL,
  origin_item_id     TEXT NOT NULL,
  origin_row_version INTEGER NOT NULL CHECK (origin_row_version >= 0),
  audience_row_version INTEGER NOT NULL DEFAULT 0
    CHECK (audience_row_version >= 0),
  PRIMARY KEY (authority_id, target_type, target_id),
  FOREIGN KEY (target_type, target_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX share_subscription_lineage_target
  ON share_subscription_lineage(target_type, target_id);

-- MEMBERSHIP IS EXPLICIT STATE, ON THE ORIGIN (#996, R10).
--
-- What a grant's closure held when it was last served. At each commit that
-- touches a closure the origin recomputes the predicate and diffs it against
-- these rows; the difference IS the enter/leave halves of the three outputs,
-- and it is the only thing that can produce them: an existing photograph added
-- to a shared album writes ONE log row (the collection entry), while four rows
-- enter the audience's copy — so the log alone can never say what entered.
--
-- \`table_name\` and \`pk\` are the PHYSICAL table and \`replica_log.pk_json\` —
-- the log's own key, JSON-encoded in declared key order — so a member row and
-- a log row join by equality and a composite key needs no second column.
--
-- \`entered_seq\` is the origin log seq at which the row entered. It is what
-- makes an \`enter\` idempotent on reconnect after retention expiry: without it
-- a re-entered row cannot be told from one the audience has held all along.
CREATE TABLE share_subscription_member (
  authority_id TEXT NOT NULL,
  table_name   TEXT NOT NULL,
  pk           TEXT NOT NULL,
  entered_seq  INTEGER NOT NULL CHECK (entered_seq >= 0),
  PRIMARY KEY (authority_id, table_name, pk)
) STRICT;
-- The REVERSE question — "which live grants claim this row" — asked by the
-- closure diff, the purge sweep and the leave output alike.
CREATE INDEX share_subscription_member_row
  ON share_subscription_member(table_name, pk);
${touchUpdatedAt("share_subscription", ["authority_id", "audience_vault_id"])}
`;
