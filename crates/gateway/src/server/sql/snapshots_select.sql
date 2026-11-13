SELECT name, taken_at_ms, registered_at_ms, epoch, generation, writes, prev, signature, held_at_ms, purge_after_ms
FROM snapshot WHERE vault = ?1 AND name > ?2
ORDER BY name
LIMIT ?3
