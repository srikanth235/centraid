SELECT secret_hash, created_at_ms, expires_at_ms, used_at_ms, used_by FROM pairing_secret INDEXED BY pairing_secret_unspent
WHERE used_at_ms IS NULL AND expires_at_ms > ?1
ORDER BY created_at_ms, secret_hash
LIMIT 1
