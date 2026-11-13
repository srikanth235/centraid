INSERT INTO claim (vault, epoch, head_seen, nonce, signature, claimed_at_ms)
VALUES (?1, ?2, ?3, ?4, ?5, ?6)
ON CONFLICT (vault) DO UPDATE SET
  epoch = excluded.epoch,
  head_seen = excluded.head_seen,
  nonce = excluded.nonce,
  signature = excluded.signature,
  claimed_at_ms = excluded.claimed_at_ms
