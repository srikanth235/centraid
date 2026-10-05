INSERT INTO pairing_secret (secret_hash, created_at_ms, expires_at_ms, used_at_ms, used_by)
VALUES (?1, ?2, ?3, ?4, ?5)
ON CONFLICT (secret_hash) DO UPDATE SET
  created_at_ms = excluded.created_at_ms,
  expires_at_ms = excluded.expires_at_ms,
  used_at_ms = excluded.used_at_ms,
  used_by = excluded.used_by
