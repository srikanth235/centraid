// P5 durable lifecycle ledger (issue #630). Domain tables remain canonical;
// this append-only sidecar records the exact pre-mutation state needed for
// history and deterministic undo. It deliberately has no polymorphic foreign
// key: an entity's history must survive its soft-delete grace window and, for
// audit/export, may outlive the row it described.

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
  actor_party_id TEXT REFERENCES core_party(party_id)
) STRICT;
CREATE INDEX core_entity_revision_entity_idx
  ON core_entity_revision(entity_type, entity_id, recorded_at DESC);
CREATE INDEX core_entity_revision_undo_idx
  ON core_entity_revision(undo_until)
  WHERE undone_at IS NULL;
`;
