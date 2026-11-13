SELECT secret_hash, created_at_ms, expires_at_ms, used_at_ms, used_by FROM pairing_secret
WHERE used_at_ms IS NULL AND expires_at_ms > ?1
ORDER BY expires_at_ms, secret_hash
LIMIT 1
