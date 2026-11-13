-- The chunk digests of every blob part this phone sealed (#1191, E9, E10): what a manifest's
-- blobs tree carries as `d`, and what a read-back of an original checks a chunk against. A cache
-- of the sealed bytes' own truth; a row with no part left in any kept snapshot or the vault is
-- forgotten by retention. `d` is the 32-byte digests, one after another, in chunk order.
CREATE TABLE part_digests (
  name TEXT PRIMARY KEY CHECK (length(name) = 64 AND name NOT GLOB '*[^0-9a-f]*'),
  d    BLOB NOT NULL CHECK (length(d) % 32 = 0)
) STRICT, WITHOUT ROWID;
