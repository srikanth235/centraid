DELETE FROM pairing_secret WHERE used_at_ms IS NULL AND expires_at_ms <= ?1
