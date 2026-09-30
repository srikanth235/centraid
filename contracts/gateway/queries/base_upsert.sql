-- One base: the `base`-kind objects one commit brought, under that commit's
-- manifest head. `received_at_ms` is the gateway's own clock (F10).
INSERT INTO base (vault_key, base_id, generation, received_at_ms, padded_size,
                  tombstoned)
VALUES (?1, ?2, ?3, ?4, ?5, ?6)
ON CONFLICT (vault_key, base_id) DO UPDATE SET
  generation     = excluded.generation,
  received_at_ms = excluded.received_at_ms,
  padded_size    = excluded.padded_size,
  tombstoned     = excluded.tombstoned;
