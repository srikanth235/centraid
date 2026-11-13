SELECT vault, name, digest, size, stored_at_ms, held_at_ms, purge_after_ms, damaged_at_ms
FROM object
WHERE (vault, name) > (?1, ?2)
ORDER BY vault, name
LIMIT ?3
