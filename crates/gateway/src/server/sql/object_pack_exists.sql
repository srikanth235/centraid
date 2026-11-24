SELECT 1
FROM object INDEXED BY object_by_pack
WHERE vault = ?1 AND pack_id = ?2
LIMIT 1
