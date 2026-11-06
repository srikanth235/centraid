-- Reminders reuse the same durable source identity and three-way field merge.
CREATE TABLE origin_next (
  id         TEXT PRIMARY KEY,
  system     TEXT NOT NULL CHECK (system IN ('contacts','calendar','files','health','statement','reminders')),
  ref        TEXT NOT NULL CHECK (length(trim(ref)) > 0),
  label      TEXT NOT NULL CHECK (length(trim(label)) > 0),
  device_id  TEXT,
  fills      TEXT REFERENCES entity(id),
  config     TEXT CHECK (config IS NULL OR json_valid(config)),
  created_at TEXT NOT NULL,
  UNIQUE (system, ref),
  UNIQUE (id, system),
  -- A statement is an account's, not a phone's store (#1146).
  CHECK (system <> 'statement' OR device_id IS NULL)
) STRICT;
-- One statement origin per account, whatever ref an import names (#1146).

CREATE TABLE source_next (
  id          TEXT PRIMARY KEY,
  origin_id   TEXT NOT NULL,
  system      TEXT NOT NULL,
  external_id TEXT NOT NULL CHECK (length(trim(external_id)) > 0),
  device_id   TEXT,
  entity_id   TEXT,
  entity_kind TEXT,
  stated      TEXT NOT NULL CHECK (json_valid(stated)),
  seen_at     TEXT NOT NULL,
  -- When the follower trashed the row because its record left a complete read: the trash it may
  -- undo if the record returns and the member has not touched the row since (#1146).
  gone_at     TEXT,
  FOREIGN KEY (origin_id, system) REFERENCES origin_next(id, system),
  FOREIGN KEY (entity_id, entity_kind) REFERENCES entity(id, kind) ON DELETE SET NULL,
  CHECK ((entity_id IS NULL) = (entity_kind IS NULL)),
  CHECK (system <> 'statement' OR device_id IS NULL),
  CHECK (entity_kind IS NULL OR system || '/' || entity_kind IN
    ('contacts/person','calendar/event','files/document','health/activity','statement/txn','reminders/task'))
) STRICT;

INSERT INTO origin_next SELECT * FROM origin;
INSERT INTO source_next SELECT * FROM source;
DROP TABLE source;
DROP TABLE origin;
ALTER TABLE origin_next RENAME TO origin;
ALTER TABLE source_next RENAME TO source;
CREATE UNIQUE INDEX origin_one_statement_per_account ON origin(fills) WHERE system = 'statement';
CREATE UNIQUE INDEX source_key ON source(origin_id, external_id, ifnull(device_id, ''));
CREATE UNIQUE INDEX source_entity ON source(entity_id) WHERE entity_id IS NOT NULL;
CREATE TRIGGER source_tombstone_is_final BEFORE UPDATE OF entity_id ON source
  WHEN old.entity_id IS NULL AND new.entity_id IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'a purged row''s source never takes a row again'); END;
