// A SHARE IS A SUBSCRIPTION (#929). The audience vault subscribes to a
// grant-keyed replica shape the origin serves; these two tables are the seat's
// half of that. Both ride the canonical walk — a restore without them hands
// back a vault that has forgotten which shapes it holds rows for, so a later
// revoke would find nothing to purge and the copy would outlive the answer.

import { UPDATED_AT_DEFAULT, touchUpdatedAt } from "./updated-at.js";

export const SHARE_SUBSCRIPTION_DDL = `
-- ONE ROW PER (shape, audience vault), on BOTH seats. The origin holds one per
-- audience it serves and reads \`cursor_seq\` as the audience's acknowledgement;
-- the audience holds exactly one — its own — and reads it as how far it has
-- ingested. Same question, two seats, one shape: a second table would let the
-- two answers drift, which is what makes a revoke settle early.
CREATE TABLE share_subscription (
  shape_id          TEXT NOT NULL,
  audience_vault_id TEXT NOT NULL,
  -- NO FOREIGN KEY to \`share_authority\`, deliberately: the AUDIENCE holds this
  -- row and never holds the origin's answer. Same reading as the member seat's
  -- intent overlay — a key here would make holding the subscription depend on
  -- holding the grant that authorizes it, which only the origin has.
  grant_id          TEXT NOT NULL,
  origin_vault_id   TEXT NOT NULL,
  subject_type      TEXT NOT NULL,
  -- The origin's replica epoch this cursor is measured in. A changed epoch is
  -- a re-bootstrap, exactly as it is for a device (the phone's rule): the seat
  -- does not extend a floor on a subscriber's behalf.
  cursor_epoch      TEXT,
  cursor_seq        INTEGER NOT NULL DEFAULT 0 CHECK (cursor_seq >= 0),
  -- What the seat last ingested, over everything a field update cannot express
  -- (which rows, an album's membership, a folder's filing, a Tally sub-graph).
  -- Unequal is re-projection; equal turns a refreshed shape into one UPDATE per
  -- moved row, which is what stops a one-field edit waking every device.
  structure_digest  TEXT,
  -- 'removed' is the audience's own acknowledgement that the shape's rows are
  -- gone. The origin's \`share_fulfillment\` vocabulary is untouched.
  state             TEXT NOT NULL CHECK (state IN ('subscribed','removed')),
  subscribed_at     TEXT NOT NULL,
  removed_at        TEXT,
  detail            TEXT,
  updated_at        TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  PRIMARY KEY (shape_id, audience_vault_id)
) STRICT;
CREATE INDEX share_subscription_grant ON share_subscription(grant_id);

-- SHAPE-KEYED LINEAGE. \`core_share_origin\` answers "which vault did this row
-- come from" and is keyed by the row, so it can name only ONE sender; two
-- grants over the same photograph therefore left the second one invisible, and
-- revoking the first purged a row the second still delivers. This table is the
-- many-to-many the model actually has: a row survives a purge while any other
-- live shape still claims it.
--
-- \`origin_row_version\` is the ORIGIN's current-epoch replica change sequence
-- for the row at ingest. It is what lets a member's phone drop a pending write
-- only once its replica holds the origin's answered version, so it travels with
-- the row rather than being re-derived from the audience's own log.
CREATE TABLE share_subscription_lineage (
  shape_id           TEXT NOT NULL,
  target_type        TEXT NOT NULL,
  target_id          TEXT NOT NULL,
  origin_item_id     TEXT NOT NULL,
  origin_row_version INTEGER NOT NULL CHECK (origin_row_version >= 0),
  PRIMARY KEY (shape_id, target_type, target_id),
  FOREIGN KEY (target_type, target_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX share_subscription_lineage_target
  ON share_subscription_lineage(target_type, target_id);
${touchUpdatedAt("share_subscription", ["shape_id", "audience_vault_id"])}
`;
