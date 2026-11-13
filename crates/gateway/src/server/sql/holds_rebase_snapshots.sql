UPDATE snapshot SET purge_after_ms = ?1 WHERE held_at_ms IS NOT NULL
