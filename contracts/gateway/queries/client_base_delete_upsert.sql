INSERT INTO client_base_delete (vault_key, deleted_at_ms)
VALUES (?1, ?2)
ON CONFLICT (vault_key) DO UPDATE SET deleted_at_ms = excluded.deleted_at_ms;
