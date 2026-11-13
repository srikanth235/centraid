UPDATE object SET purge_after_ms = purge_after_ms + ?2
WHERE vault = ?1 AND held_at_ms IS NOT NULL
