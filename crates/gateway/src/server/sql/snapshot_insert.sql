INSERT INTO snapshot (vault, name, taken_at_ms, registered_at_ms)
VALUES (?1, ?2, ?3, ?4)
ON CONFLICT (vault, name) DO NOTHING
