-- The per-object audit ledger. The rate limit reads `client_base_delete`; this
-- is what an owner reads when asked what a device deleted and when.
INSERT INTO client_delete (vault_key, object_name, kind, deleted_at_ms)
VALUES (?1, ?2, ?3, ?4)
ON CONFLICT (vault_key, object_name) DO UPDATE SET
  kind          = excluded.kind,
  deleted_at_ms = excluded.deleted_at_ms;
