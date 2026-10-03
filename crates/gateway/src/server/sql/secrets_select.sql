SELECT secret_hash, created_at_ms, expires_at_ms, used_at_ms, used_by FROM pairing_secret
ORDER BY created_at_ms, secret_hash
