-- The device state of a phone's backup (#1209, spec §6.1): derived, never inside the vault, and
-- rebuilt from the gateways' answers, so a reset costs a re-pair and a re-ask. There is no outbox:
-- what a gateway is owed is the difference between two trees, not a list kept on the side. The
-- gateway token is not here (E12): the shell keeps it.

CREATE TABLE gateway (
  gateway_id      TEXT PRIMARY KEY CHECK (length(gateway_id) BETWEEN 1 AND 64),
  addrs           TEXT NOT NULL,
  cert_der        BLOB NOT NULL,
  label           TEXT NOT NULL,
  epoch           INTEGER NOT NULL CHECK (epoch >= 1),
  generation      INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  -- The head this phone last confirmed there: records are held whole. `conf_ms` is when.
  conf            TEXT CHECK (conf IS NULL OR (length(conf) = 64 AND conf NOT GLOB '*[^0-9a-f]*')),
  conf_ms         INTEGER,
  -- The roots whose thumbnails and originals are confirmed whole there.
  troot           TEXT CHECK (troot IS NULL OR (length(troot) = 64 AND troot NOT GLOB '*[^0-9a-f]*')),
  troot_ms        INTEGER,
  oroot           TEXT CHECK (oroot IS NULL OR (length(oroot) = 64 AND oroot NOT GLOB '*[^0-9a-f]*')),
  oroot_ms        INTEGER,
  reach           TEXT NOT NULL DEFAULT 'ok' CHECK (reach IN
                    ('ok', 'unreachable', 'untrusted', 'too_old', 'pair_again', 'moved', 'frozen', 'busy')),
  moved_epoch     INTEGER CHECK ((reach = 'moved') = (moved_epoch IS NOT NULL)),
  reach_ms        INTEGER,
  paired_ms       INTEGER NOT NULL,
  sample_counter  INTEGER NOT NULL DEFAULT 0 CHECK (sample_counter >= 0),
  scrub_cursor    TEXT CHECK (scrub_cursor IS NULL OR (length(scrub_cursor) = 64 AND scrub_cursor NOT GLOB '*[^0-9a-f]*')),
  directory_dirty INTEGER NOT NULL DEFAULT 1 CHECK (directory_dirty IN (0, 1)),
  -- The last head that did not match `conf` went backwards (a lower writer position, or no head, or
  -- not a successor of `conf`): the gateway reads as rolled back until a new head is confirmed there.
  regressed       INTEGER NOT NULL DEFAULT 0 CHECK (regressed IN (0, 1)),
  CHECK ((conf IS NULL) = (conf_ms IS NULL)),
  CHECK ((troot IS NULL) = (troot_ms IS NULL)),
  CHECK ((oroot IS NULL) = (oroot_ms IS NULL))
) STRICT;

-- The tree nodes of every root a gateway's `conf`, `troot` or `oroot` names, the newest snapshot
-- and the snapshots retention keeps. A node is a pure function of its content, so its plaintext
-- is all that is kept: the sealed object is rebuilt from it.
CREATE TABLE node (
  name      TEXT PRIMARY KEY CHECK (length(name) = 64 AND name NOT GLOB '*[^0-9a-f]*'),
  plaintext BLOB NOT NULL CHECK (length(plaintext) > 0)
) STRICT, WITHOUT ROWID;

-- Files in the staging area (§6.4): sealed vault ranges between the pin and their confirmation,
-- and originals whose bytes only the OS photo library holds.
CREATE TABLE staged (
  name TEXT PRIMARY KEY CHECK (length(name) = 64 AND name NOT GLOB '*[^0-9a-f]*'),
  path TEXT NOT NULL CHECK (length(path) > 0),
  size INTEGER NOT NULL CHECK (size >= 0)
) STRICT, WITHOUT ROWID;

-- Where a hash's bytes are on this device: the app's own content store, or the OS photo library,
-- under an identifier only the shell resolves. The blobs door reads it to locate an original.
CREATE TABLE local_bytes (
  hash   TEXT PRIMARY KEY CHECK (length(hash) = 64 AND hash NOT GLOB '*[^0-9a-f]*'),
  source TEXT NOT NULL CHECK (source IN ('os', 'store')),
  ref    TEXT CHECK ((source = 'os') = (ref IS NOT NULL AND ref <> '')),
  edited INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0, 1) AND (edited = 0 OR source = 'os'))
) STRICT;

-- The chunk refs of an original whose bytes only the OS photo library holds (§6.4). The stage
-- door seals the stream once to learn them; the sealed chunks that fit go to staging, and the
-- snapshot lists these refs in the tree so a gateway can be owed them before every byte is staged.
CREATE TABLE os_chunk (
  hash   TEXT NOT NULL CHECK (length(hash) = 64 AND hash NOT GLOB '*[^0-9a-f]*'),
  idx    INTEGER NOT NULL CHECK (idx >= 0),
  name   TEXT NOT NULL CHECK (length(name) = 64 AND name NOT GLOB '*[^0-9a-f]*'),
  digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
  len    INTEGER NOT NULL CHECK (len > 0),
  PRIMARY KEY (hash, idx)
) STRICT, WITHOUT ROWID;

-- The one row of what the snapshot reads need to remember: the newest snapshot's root, how many
-- snapshots since a full read (and when it was), the pages written during the last pin (which the
-- next snapshot reads although the checkpoint has since moved them out of the WAL), and the
-- fingerprint of the main vault file after the last checkpoint so any checkpoint made behind the
-- core's back (including a clean close) forces a full read on the next snapshot.
CREATE TABLE device (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  newest         TEXT CHECK (newest IS NULL OR (length(newest) = 64 AND newest NOT GLOB '*[^0-9a-f]*')),
  newest_ms      INTEGER,
  since_full     INTEGER NOT NULL DEFAULT 0 CHECK (since_full >= 0),
  full_ms        INTEGER,
  carry          BLOB NOT NULL DEFAULT x'' CHECK (length(carry) % 4 = 0),
  disk_mark      BLOB CHECK (disk_mark IS NULL OR length(disk_mark) = 32),
  exclude_videos INTEGER NOT NULL DEFAULT 0 CHECK (exclude_videos IN (0, 1)),
  CHECK ((newest IS NULL) = (newest_ms IS NULL))
) STRICT;

INSERT INTO device (id) VALUES (1);

-- Names a member's Undo lifted the hold on (E6): collection does not delete them again until
-- `until_ms`, so an Undo is not undone by the next pass.
CREATE TABLE undone (
  gateway_id TEXT NOT NULL REFERENCES gateway (gateway_id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (length(name) = 64 AND name NOT GLOB '*[^0-9a-f]*'),
  until_ms   INTEGER NOT NULL,
  PRIMARY KEY (gateway_id, name)
) STRICT, WITHOUT ROWID;

-- Bundle files handed to the OS background session (§6.5): kept out of `staged` so
-- housekeeping does not release them under an in-flight upload, and persisted so a crash
-- or restart does not leak them against the staging budget.
CREATE TABLE os_bundle (
  name TEXT PRIMARY KEY CHECK (length(name) = 64 AND name NOT GLOB '*[^0-9a-f]*'),
  path TEXT NOT NULL CHECK (length(path) > 0)
) STRICT, WITHOUT ROWID;
