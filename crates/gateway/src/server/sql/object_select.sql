SELECT name, digest, size, stored_at_ms, tombstoned_at_ms, purge_after_ms, damaged_at_ms
FROM object WHERE vault = ?1 AND name = ?2
