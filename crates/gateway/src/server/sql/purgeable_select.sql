SELECT purge_after_ms, vault, name FROM object
WHERE purge_after_ms IS NOT NULL AND purge_after_ms <= ?4 AND (purge_after_ms, vault, name) > (?1, ?2, ?3)
ORDER BY purge_after_ms, vault, name
LIMIT ?5
