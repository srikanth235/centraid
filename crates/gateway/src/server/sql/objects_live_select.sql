SELECT name, digest, size, stored_at_ms, tombstoned_at_ms, purge_after_ms, damaged_at_ms
FROM object
WHERE vault = ?1 AND (?2 IS NULL OR name > ?2) AND tombstoned_at_ms IS NULL
ORDER BY name
LIMIT ?3
