SELECT vault, name, digest, size, stored_at_ms, tombstoned_at_ms, purge_after_ms, damaged_at_ms
FROM object
WHERE ?1 IS NULL OR (vault, name) > (?1, ?2)
ORDER BY vault, name
LIMIT ?3
