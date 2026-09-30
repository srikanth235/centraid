-- The account a vault is held under. No email address, no phone number and no
-- name: there is no column for one.
INSERT INTO account (account_key, admitted_at_ms, quota_bytes)
VALUES (?1, ?2, ?3)
ON CONFLICT (account_key) DO UPDATE SET
  quota_bytes = excluded.quota_bytes;
