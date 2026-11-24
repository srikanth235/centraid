SELECT name, digest, size, pack_pos, damaged_at_ms
FROM object INDEXED BY object_by_pack
WHERE vault = ?1 AND pack_id = ?2 AND (pack_pos, name) > (?3, ?4)
ORDER BY pack_pos, name
LIMIT ?5
