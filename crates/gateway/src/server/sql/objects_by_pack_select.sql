SELECT vault, pack_id, pack_pos, name, digest, size, stored_at_ms, held_at_ms, purge_after_ms, damaged_at_ms
FROM object INDEXED BY object_by_pack
WHERE (vault, pack_id, pack_pos, name) > (?1, ?2, ?3, ?4)
ORDER BY vault, pack_id, pack_pos, name
LIMIT ?5
