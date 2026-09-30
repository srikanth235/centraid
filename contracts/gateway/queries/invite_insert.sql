-- An invite is a bearer secret, so the server stores its BLAKE3 and never the
-- secret: a stolen database must not be a set of working invitations.
INSERT INTO invite (code_hash, quota_bytes, created_at_ms, expires_at_ms,
                    redeemed_at_ms, redeemed_by)
VALUES (?1, ?2, ?3, ?4, NULL, NULL);
