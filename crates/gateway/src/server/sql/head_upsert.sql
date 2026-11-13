INSERT INTO head (vault, name, prev, taken_at_ms, epoch, generation, writes, set_at_ms, signature)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
ON CONFLICT (vault) DO UPDATE SET
  name = excluded.name,
  prev = excluded.prev,
  taken_at_ms = excluded.taken_at_ms,
  epoch = excluded.epoch,
  generation = excluded.generation,
  writes = excluded.writes,
  set_at_ms = excluded.set_at_ms,
  signature = excluded.signature
