export const OUTBOX_DDL = `
CREATE TABLE IF NOT EXISTS outbox_grant (
  grant_id   TEXT PRIMARY KEY,
  actor_id   TEXT NOT NULL,
  verb       TEXT NOT NULL,
  target     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_grant_rule
  ON outbox_grant(actor_id, verb, target) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS outbox_item (
  item_id              TEXT PRIMARY KEY,
  connection_id        TEXT NOT NULL REFERENCES sync_connection(connection_id),
  actor_id             TEXT NOT NULL,
  actor_kind           TEXT NOT NULL CHECK (actor_kind IN ('owner','app','ai_agent')),
  verb                 TEXT NOT NULL,
  target               TEXT NOT NULL,
  target_type          TEXT,
  target_id            TEXT,
  recipient_party_id   TEXT REFERENCES core_party(party_id),
  artifact_json        TEXT NOT NULL CHECK (json_valid(artifact_json)),
  request_json         TEXT NOT NULL CHECK (json_valid(request_json)),
  status               TEXT NOT NULL CHECK (status IN ('pending','approved','sent','discarded','failed')),
  grant_id             TEXT REFERENCES outbox_grant(grant_id),
  staged_at            TEXT NOT NULL,
  decided_at           TEXT,
  drained_at           TEXT,
  result_json          TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  published_message_id TEXT REFERENCES social_message(message_id),
  note                 TEXT,
  CHECK ((target_type IS NULL) = (target_id IS NULL)),
  -- A REAL reference (#916, E1). This was an audit value — "the row this was
  -- about" — and that reading is wrong for a queue: an item still PENDING when
  -- its subject is purged would drain afterwards and publish an artifact about
  -- a row the member deleted. The pair is a composite key into the entity
  -- supertype and cascades, so a purge empties the queue of anything about it.
  -- A NULL pair (an outbound write with no canonical subject) satisfies a
  -- composite foreign key by definition, which is the right reading.
  FOREIGN KEY (target_type, target_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_outbox_item_target
  ON outbox_item(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_outbox_item_status ON outbox_item(status, staged_at);
CREATE INDEX IF NOT EXISTS idx_outbox_item_connection ON outbox_item(connection_id);
CREATE INDEX IF NOT EXISTS idx_outbox_item_recipient_party ON outbox_item(recipient_party_id);
CREATE INDEX IF NOT EXISTS idx_outbox_item_grant ON outbox_item(grant_id);
CREATE INDEX IF NOT EXISTS idx_outbox_item_published_message ON outbox_item(published_message_id);
`;
