DELETE FROM pairing_secret WHERE used_at_ms IS NOT NULL AND used_at_ms <= ?1
