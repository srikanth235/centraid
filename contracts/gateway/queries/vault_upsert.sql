-- Registration, a lease claim and a quota update are all this one write.
--
-- `head_object` is deliberately NOT written here: the head moves only through
-- `head_update.sql`, under BEGIN IMMEDIATE, which is what gives a plain SQLite
-- server the guarantee a Durable Object gets from single-threading (F7).
INSERT INTO vault (vault_key, account_key, registered_at_ms, lease_device,
                   lease_epoch, lease_taken_at_ms, head_object, head_set_at_ms,
                   moved_at_ms, append_only, used_bytes)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
ON CONFLICT (vault_key) DO UPDATE SET
  account_key       = excluded.account_key,
  lease_device      = excluded.lease_device,
  lease_epoch       = excluded.lease_epoch,
  lease_taken_at_ms = excluded.lease_taken_at_ms,
  moved_at_ms       = excluded.moved_at_ms,
  append_only       = excluded.append_only,
  used_bytes        = excluded.used_bytes;
