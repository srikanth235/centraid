INSERT INTO head (vault, name, taken_at_ms, set_at_ms)
VALUES (?1, ?2, ?3, ?4)
ON CONFLICT (vault) DO UPDATE SET
  name = excluded.name,
  taken_at_ms = excluded.taken_at_ms,
  set_at_ms = excluded.set_at_ms
