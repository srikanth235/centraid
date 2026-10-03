SELECT vault, name FROM object
WHERE purge_after_ms IS NOT NULL AND purge_after_ms <= ?1
ORDER BY purge_after_ms, vault, name
LIMIT ?2
