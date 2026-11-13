SELECT epoch FROM token WHERE vault = ?1 ORDER BY created_at_ms, token_hash
