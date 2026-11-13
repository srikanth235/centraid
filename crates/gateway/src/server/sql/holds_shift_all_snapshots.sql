UPDATE snapshot INDEXED BY snapshot_held SET purge_after_ms = purge_after_ms + ?1 WHERE held_at_ms IS NOT NULL
