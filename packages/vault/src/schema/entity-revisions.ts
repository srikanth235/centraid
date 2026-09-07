// P5 durable lifecycle ledger (#630). Domain tables remain canonical;
// this append-only sidecar records the exact pre-mutation state needed for
// history and deterministic undo. It deliberately has no polymorphic foreign
// key: an entity's history must survive its soft-delete grace window and, for
// audit/export, may outlive the row it described.
//
// THE ONE REVISION MECHANISM (#916, owner decision D2). `locker_item_history`
// was a second one — same question, different table, different retention, its
// own undo path — and it is gone; a Locker revision is a row here with
// `entity_type = 'locker.item'`, its old values in `snapshot_json` and its
// sealed columns still ciphertext. How LONG revisions are kept per entity is
// declared in the registry (`revisions: { retain }` in `entity-catalog.ts`),
// not decided by whichever sweep happens to run.

import {
  ROW_VERSION_COLUMN,
  UPDATED_AT_DEFAULT,
  touchUpdatedAt,
} from "./updated-at.js";

export const ENTITY_REVISIONS_DDL = `
CREATE TABLE core_entity_revision (
  revision_id    TEXT PRIMARY KEY,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  operation      TEXT NOT NULL,
  snapshot_json  TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  recorded_at    TEXT NOT NULL,
  undo_until     TEXT NOT NULL,
  undone_at      TEXT,
  -- ATTRIBUTION (#916, D1): the actor is who did it, and a snapshot whose
  -- actor was purged is still the snapshot. It yields rather than blocking.
  actor_party_id TEXT REFERENCES core_party(party_id) ON DELETE SET NULL,
  -- The command that caused this revision (#916, D2 / review 5.2). Same file
  -- as the audit band now, so it is a REAL key: SET NULL rather than CASCADE
  -- because the archive pass removes old invocations and a revision outlives
  -- the invocation record of it.
  invocation_id  TEXT
    REFERENCES agent_command_invocation(invocation_id) ON DELETE SET NULL,
  -- THE REVISION OCCURRENCE (#996, ruling R20(a) / #916's ONT-revisions).
  --
  -- This table was ruled "the only history table", and a SECOND history graph
  -- went on living beside it: a content→content \`revises\` \`core_link\` written
  -- on every body edit and walked by Docs, Notes, the mobile version list, the
  -- blob door and the purge sweep. Identity was taken from a VALUE — the
  -- content id was the version id — so two documents with identical bytes
  -- shared one history, A→B→A→B could not be expressed, and a revision of one
  -- object could be restored into another.
  --
  -- An OCCURRENCE is a row here whose \`operation\` is 'revise': it names the
  -- content that became current at that moment and the occurrence before it,
  -- and the wrapper points at the newest. A capture snapshot (every other row)
  -- names no content and is bounded by the entity's declared retention; an
  -- occurrence is a member's authored version and is not (#996, OQ-11).
  --
  -- Both \`ON DELETE SET NULL\`. \`content_id\`: a purge is allowed to reclaim the
  -- bytes, and the occurrence survives as the record that there WAS a version
  -- there — the alternative is a foreign key that refuses to let an owner
  -- delete their own document. \`parent_revision_id\`: a truncated chain is a
  -- legible answer where a dangling one is not.
  content_id     TEXT
    REFERENCES core_content_item(content_id) ON DELETE SET NULL,
  parent_revision_id TEXT
    REFERENCES core_entity_revision(revision_id) ON DELETE SET NULL,
  updated_at     TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  ${ROW_VERSION_COLUMN},
  FOREIGN KEY (revision_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
-- "Which versions named these bytes" is what the blob door and the purge sweep
-- ask; "what came before this" is what every history reader asks.
CREATE INDEX core_entity_revision_content_idx
  ON core_entity_revision(content_id) WHERE content_id IS NOT NULL;
CREATE INDEX core_entity_revision_parent_idx
  ON core_entity_revision(parent_revision_id) WHERE parent_revision_id IS NOT NULL;
CREATE INDEX core_entity_revision_entity_idx
  ON core_entity_revision(entity_type, entity_id, recorded_at DESC);
CREATE INDEX core_entity_revision_undo_idx
  ON core_entity_revision(undo_until)
  WHERE undone_at IS NULL;
CREATE INDEX core_entity_revision_actor_idx
  ON core_entity_revision(actor_party_id);
CREATE INDEX core_entity_revision_invocation_idx
  ON core_entity_revision(invocation_id) WHERE invocation_id IS NOT NULL;
${touchUpdatedAt("core_entity_revision", "revision_id")}
`;
