SELECT token_hash, vault, epoch, kind, label, created_at_ms FROM token
ORDER BY vault, created_at_ms, token_hash
