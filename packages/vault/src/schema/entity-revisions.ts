import { UPDATED_AT_DEFAULT, touchUpdatedAt } from "./updated-at.js";

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
  updated_at     TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  FOREIGN KEY (revision_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
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
