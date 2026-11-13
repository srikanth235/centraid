INSERT INTO revoked_token (token_hash, vault, epoch, revoked_at_ms)
VALUES (?1, ?2, ?3, ?4)
ON CONFLICT (token_hash) DO UPDATE SET
  vault = excluded.vault,
  epoch = excluded.epoch,
  revoked_at_ms = excluded.revoked_at_ms
