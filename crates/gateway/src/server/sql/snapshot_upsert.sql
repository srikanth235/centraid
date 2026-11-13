INSERT INTO snapshot
  (vault, name, taken_at_ms, registered_at_ms, epoch, generation, writes, prev, signature, held_at_ms, purge_after_ms)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
ON CONFLICT (vault, name) DO UPDATE SET
  taken_at_ms = excluded.taken_at_ms,
  epoch = excluded.epoch,
  generation = excluded.generation,
  writes = excluded.writes,
  prev = excluded.prev,
  signature = excluded.signature,
  held_at_ms = excluded.held_at_ms,
  purge_after_ms = excluded.purge_after_ms
