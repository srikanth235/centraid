-- The device state of a phone's backup (#1191, E11): three tables, STRICT, no
-- key-value table. The gateway token is not here (E12): the shell keeps it.

CREATE TABLE gateway (
  gateway_id      TEXT PRIMARY KEY CHECK (length(gateway_id) = 32 AND gateway_id NOT GLOB '*[^0-9a-f]*'),
  addrs           TEXT NOT NULL,
  cert_der        BLOB NOT NULL,
  label           TEXT NOT NULL,
  epoch           INTEGER NOT NULL CHECK (epoch >= 1),
  head            TEXT CHECK (head IS NULL OR (length(head) = 64 AND head NOT GLOB '*[^0-9a-f]*')),
  generation      INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  writes          INTEGER NOT NULL DEFAULT 0 CHECK (writes >= 0),
  cursor          INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  reach           TEXT NOT NULL DEFAULT 'ok' CHECK (reach IN
                    ('ok', 'unreachable', 'pair_again', 'refused_disk', 'refused_large', 'refused_other',
                     'moved', 'frozen', 'gateway_old', 'busy')),
  moved_epoch     INTEGER CHECK ((reach = 'moved') = (moved_epoch IS NOT NULL)),
  reach_ms        INTEGER,
  paired_ms       INTEGER NOT NULL,
  seen_ms         INTEGER,
  ack_ms          INTEGER,
  sample_counter  INTEGER NOT NULL DEFAULT 0 CHECK (sample_counter >= 0),
  directory_dirty INTEGER NOT NULL DEFAULT 1 CHECK (directory_dirty IN (0, 1))
) STRICT;

CREATE TABLE outbox (
  gateway_id TEXT NOT NULL REFERENCES gateway (gateway_id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (length(name) = 64 AND name NOT GLOB '*[^0-9a-f]*'),
  kind       TEXT NOT NULL CHECK (kind IN ('range', 'leaf', 'manifest', 'directory', 'blob')),
  hash       TEXT CHECK ((kind = 'blob') = (hash IS NOT NULL)),
  part_path  TEXT,
  waiting    TEXT CHECK (waiting IS NULL OR (waiting IN ('lapsed', 'bytes') AND part_path IS NULL)),
  size       INTEGER CHECK (part_path IS NULL OR size >= 0),
  digest     TEXT CHECK ((part_path IS NULL) = (digest IS NULL)),
  media_type TEXT CHECK ((kind = 'blob') = (media_type IS NOT NULL)),
  created_ms INTEGER NOT NULL,
  handed_ms  INTEGER,
  attempts   INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  PRIMARY KEY (gateway_id, name)
) STRICT, WITHOUT ROWID;

CREATE INDEX outbox_in_order ON outbox (gateway_id, kind = 'manifest', created_ms, name);
CREATE INDEX outbox_waiting ON outbox (gateway_id, waiting, name) WHERE waiting IS NOT NULL;

CREATE TABLE local_bytes (
  hash   TEXT PRIMARY KEY CHECK (length(hash) = 64 AND hash NOT GLOB '*[^0-9a-f]*'),
  source TEXT NOT NULL CHECK (source IN ('os', 'store')),
  ref    TEXT CHECK ((source = 'os') = (ref IS NOT NULL AND ref <> '')),
  edited INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0, 1) AND (edited = 0 OR source = 'os'))
) STRICT;
