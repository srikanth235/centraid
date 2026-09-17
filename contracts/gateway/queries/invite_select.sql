SELECT code_hash, quota_bytes, created_at_ms, expires_at_ms, redeemed_at_ms,
       redeemed_by
FROM invite
WHERE code_hash = ?1;
