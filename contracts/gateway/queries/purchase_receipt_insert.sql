-- One verified receipt, by its BLAKE3. The receipt itself is never stored: it
-- is a bearer credential for somebody's store account.
INSERT INTO purchase_receipt (receipt_hash, account_key, store, verified_at_ms,
                              expires_at_ms, quota_bytes)
VALUES (?1, ?2, ?3, ?4, ?5, ?6)
ON CONFLICT (receipt_hash) DO UPDATE SET
  verified_at_ms = excluded.verified_at_ms,
  expires_at_ms  = excluded.expires_at_ms,
  quota_bytes    = excluded.quota_bytes;
