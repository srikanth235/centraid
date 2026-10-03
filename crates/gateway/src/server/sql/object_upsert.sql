INSERT INTO object
  (vault, name, digest, size, stored_at_ms, tombstoned_at_ms, purge_after_ms, damaged_at_ms)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
ON CONFLICT (vault, name) DO UPDATE SET
  digest = excluded.digest,
  size = excluded.size,
  stored_at_ms = excluded.stored_at_ms,
  tombstoned_at_ms = excluded.tombstoned_at_ms,
  purge_after_ms = excluded.purge_after_ms,
  damaged_at_ms = excluded.damaged_at_ms
