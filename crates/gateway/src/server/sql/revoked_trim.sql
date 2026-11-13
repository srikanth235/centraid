DELETE FROM revoked_token
WHERE vault = ?1 AND token_hash NOT IN (
  SELECT token_hash FROM revoked_token WHERE vault = ?1
  ORDER BY revoked_at_ms DESC, token_hash DESC LIMIT ?2
)
