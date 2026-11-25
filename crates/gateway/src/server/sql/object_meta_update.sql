UPDATE object
SET digest = ?3,
    size = ?4,
    stored_at_ms = ?5,
    held_at_ms = ?6,
    purge_after_ms = ?7,
    damaged_at_ms = ?8
WHERE vault = ?1 AND name = ?2
