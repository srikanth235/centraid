DELETE FROM nonce WHERE nonce = ?1 RETURNING issued_at_ms
