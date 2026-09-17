-- Declare, commit and tombstone are all one write: the rules decide which
-- state the row lands in, and the adapter stores what it was handed.
INSERT INTO object (vault_key, name, attested_checksum, kind, padded_size,
                    state, received_at_ms, committed_at_ms, purge_after_ms,
                    generation)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
ON CONFLICT (vault_key, name) DO UPDATE SET
  attested_checksum = excluded.attested_checksum,
  kind              = excluded.kind,
  padded_size       = excluded.padded_size,
  state             = excluded.state,
  received_at_ms    = excluded.received_at_ms,
  committed_at_ms   = excluded.committed_at_ms,
  purge_after_ms    = excluded.purge_after_ms,
  generation        = excluded.generation;
