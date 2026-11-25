SELECT name, digest, size, stored_at_ms, held_at_ms, purge_after_ms, damaged_at_ms, pack_id, pack_pos
FROM object WHERE vault = ?1 AND name = ?2
