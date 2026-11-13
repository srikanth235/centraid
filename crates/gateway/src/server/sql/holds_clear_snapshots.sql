UPDATE snapshot INDEXED BY snapshot_held SET held_at_ms = NULL, purge_after_ms = NULL
WHERE vault = ?1 AND held_at_ms IS NOT NULL
