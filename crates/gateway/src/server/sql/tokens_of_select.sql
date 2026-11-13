SELECT token_hash, vault, epoch, kind, label, created_at_ms FROM token
WHERE vault = ?1 AND (created_at_ms, token_hash) > (?2, ?3)
ORDER BY created_at_ms, token_hash
LIMIT ?4
